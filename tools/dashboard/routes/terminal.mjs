export default function terminalRoutes(deps) {
  const {
    db, json, err, parseBody,
    ROOT, LOGS_DIR, CLAUDE_BIN, TMUX_AVAILABLE,
    terminals,
    wireTerminalHandlers, injectPrompt,
    buildDispatchPrompt, resolveProjectPath, resolveOrgPath, loadPortfolioContext, loadOrgContext, loadWorkItem, selectAgentsForDispatch, loadEpicPlanSnippet,
    saveTerminalToDb, archiveSession,
    termEventLogPath, generateSeedContent, isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture,
    EventStream, getAdapter,
    pty,
    appendFileSync, unlinkFile, mkdir, join, execFileSync, writeFileSync,
  } = deps;
  return [
    // --- Terminal endpoints ---

    // Create terminal session
    [/^\/api\/terminal$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { work_item_id, epic_id, project_key, org_key, title, description, additional_instructions, skip_permissions, permission_mode, agentType: bodyAgentType, skip_seed } = body;
      const _testWorkerId = req.headers['x-test-worker-id'] ?? null;

      if (!project_key && !org_key) return err(res, 'project_key or org_key is required', 400);

      const agentType = bodyAgentType || 'claude';
      let adapter;
      try {
        adapter = getAdapter(agentType);
      } catch (e) {
        return err(res, e.message, 400);
      }

      // Resolve path and context — org-level or project-level
      let projectPath, portfolio = null, orgContext = null;
      if (org_key && !project_key) {
        projectPath = await resolveOrgPath(org_key);
        if (!projectPath) return err(res, `Could not resolve path for organization: ${org_key}`, 400);
        orgContext = await loadOrgContext(org_key);
      } else {
        projectPath = await resolveProjectPath(project_key);
        if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);
        portfolio = await loadPortfolioContext(project_key);
      }

      const id = `T-${Date.now()}`;

      // Build prompt same as dispatch
      const workItem = work_item_id ? await loadWorkItem(work_item_id) : null;

      let epicContext = null;
      if (epic_id) {
        try {
          const epicFull = db.getEpicFull(epic_id);
          if (epicFull) {
            const planSnippet = await loadEpicPlanSnippet(epic_id);
            epicContext = {
              id: epicFull.id, title: epicFull.title, status: epicFull.status,
              progress: `${epicFull.progress.done}/${epicFull.progress.total}`,
              acceptance_criteria: epicFull.acceptance_criteria, items: epicFull.resolved_items, plan_snippet: planSnippet,
            };
          }
        } catch {}
      }

      const effectiveTermWorkItem = workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null);

      const prompt = buildDispatchPrompt({
        workItem: effectiveTermWorkItem,
        projectKey: project_key || `${org_key}/*`,
        projectPath,
        additionalInstructions: additional_instructions,
        portfolio,
        epicContext,
        orgContext,
      });

      // Select sub-agents for terminal session
      const termAgentDefs = await selectAgentsForDispatch({ workItem: effectiveTermWorkItem, portfolio });

      // Resolve permission mode and skip_permissions independently
      const resolvedTermPermMode = permission_mode || 'acceptEdits';
      const resolvedTermSkipPerms = skip_permissions === true || skip_permissions === 'true';

      // Create EventStream and inject seed content before PTY starts
      const eventStream = new EventStream(id);
      await mkdir(LOGS_DIR, { recursive: true });
      if (!skip_seed) {
        const seedLines = generateSeedContent(500);
        const jsonlLines = [];
        for (const line of seedLines) {
          const seedEvent = eventStream.append('data', line + '\r\n', { synthetic: true });
          jsonlLines.push(JSON.stringify(seedEvent));
        }
        try { appendFileSync(termEventLogPath(id), jsonlLines.join('\n') + '\n'); } catch {}
      }

      // Spawn interactive PTY with claude, optionally wrapped in tmux for restart survival
      let ptyProcess;
      let tmuxName = null;
      let agentsFile = null;
      const claudeSessionId = crypto.randomUUID();
      try {
        const ptyArgs = adapter.buildArgs(claudeSessionId, {
          permissionMode: resolvedTermPermMode,
          skipPermissions: resolvedTermSkipPerms,
          addDir: ROOT,
          agentsJson: null, // will be set below if needed
        });

        if (agentType === 'claude') {
          if (termAgentDefs.length) {
            if (TMUX_AVAILABLE) {
              // Write agents JSON to temp file to avoid ARG_MAX overflow in tmux
              const tmpDir = join(ROOT, 'tmp');
              try { await mkdir(tmpDir, { recursive: true }); } catch {}
              agentsFile = join(tmpDir, `agents-${id}.json`);
              writeFileSync(agentsFile, JSON.stringify(termAgentDefs));
            } else {
              ptyArgs.push('--agents', JSON.stringify(termAgentDefs));
            }
          }

          if (TMUX_AVAILABLE) {
            tmuxName = `architect-${id}`;
            // Build shell command that reads agents from temp file to stay within ARG_MAX
            const cliParts = [CLAUDE_BIN, ...ptyArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`)];
            if (agentsFile) {
              cliParts.push('--agents', `"$(cat '${agentsFile}')"`);
            }
            const shellCmd = 'exec ' + cliParts.join(' ');
            // Create detached tmux session running claude via shell wrapper
            // exec replaces sh with claude — when claude exits, the tmux pane exits immediately
            execFileSync('tmux', [
              'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24',
              'sh', '-c', shellCmd,
            ], { cwd: projectPath, env: { ...process.env, ARCHITECT_ROOT: ROOT } });
            // Enable mouse support so SGR wheel sequences reach the inner application
            try { execFileSync('tmux', ['set-option', '-t', tmuxName, '-g', 'mouse', 'on']); } catch {}
            // Attach node-pty to the tmux session for WebSocket streaming
            ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
              name: 'xterm-256color', cols: 80, rows: 24,
              cwd: projectPath,
              env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
            });
          } else {
            ptyProcess = pty.spawn(CLAUDE_BIN, ptyArgs, {
              name: 'xterm-256color', cols: 80, rows: 24,
              cwd: projectPath,
              env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
            });
          }
        } else if (agentType === 'shell') {
          const shellBin = process.env.SHELL || '/bin/zsh';
          // Skip shell init scripts (oh-my-zsh, git hooks, mouse reporting plugins)
          // to prevent scroll interference and post-exit noise. PATH is inherited from process.env.
          const shellArgs = shellBin.endsWith('zsh') ? ['--no-rcs'] : shellBin.endsWith('bash') ? ['--norc'] : [];
          const shellEnv = { ...process.env, TERM: 'xterm-256color' };
          // Shell terminals spawn directly with node-pty (no tmux wrapper).
          // Tmux uses the alternate screen buffer which disables xterm.js scrollback —
          // the user can't scroll backwards through terminal history. Since shell terminals
          // are interactive and don't need tmux's session persistence, we skip it.
          ptyProcess = pty.spawn(shellBin, shellArgs, {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: projectPath,
            env: shellEnv,
          });
        } else {
          // Other adapters: spawn shell as fallback
          const shellBin = process.env.SHELL || '/bin/zsh';
          const shellArgs = shellBin.endsWith('zsh') ? ['--no-rcs'] : shellBin.endsWith('bash') ? ['--norc'] : [];
          ptyProcess = pty.spawn(shellBin, shellArgs, {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: projectPath,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
        }
      } catch (spawnErr) {
        // Clean up tmux session on failure
        if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
        return json(res, { error: `Failed to spawn terminal: ${spawnErr.message}` }, 500);
      }

      const terminal = {
        id,
        type: agentType,
        agent_type: agentType,
        work_item_id: work_item_id || null,
        epic_id: epic_id || null,
        project_key: project_key || (org_key ? `${org_key}/*` : null),
        org_key: org_key || null,
        project_path: projectPath,
        prompt,
        title: title || additional_instructions?.slice(0, 60) || 'Interactive session',
        permission_mode: resolvedTermPermMode,
        skip_permissions: resolvedTermSkipPerms,
        status: 'running',
        ptyProcess,
        pid: tmuxName
          ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
          : ptyProcess.pid,
        tmux_session: tmuxName,
        claude_session_id: agentType === 'claude' ? claudeSessionId : null,
        agents_file: agentsFile,
        eventStream,
        wsClients: eventStream.subscribers,
        cols: 80,
        rows: 24,
        _adapter: adapter,
        _accumulated: '',
        _pendingPrompt: agentType === 'claude' ? prompt : null,
        _readyForPrompt: agentType !== 'claude', // shell is immediately ready
        _permissionMode: resolvedTermPermMode,
        _skipPermissions: resolvedTermSkipPerms,
        _testWorkerId,
        started_at: new Date().toISOString(),
        exited_at: null,
      };

      wireTerminalHandlers(terminal);

      // For shell: no prompt injection needed
      // For claude: injectPrompt is triggered by detectReadiness in wireTerminalHandlers
      // For claude with shell fallback: inject immediately after first data
      if (agentType === 'shell') {
        // No prompt to inject
      }

      // Fallback: if claude readiness never fires, inject after MAX_WAIT
      if (agentType === 'claude') {
        const MAX_WAIT = tmuxName ? 8000 : 5000;
        setTimeout(() => {
          if (terminal._pendingPrompt && terminal.ptyProcess) {
            terminal._readyForPrompt = true;
            injectPrompt(terminal);
          }
        }, MAX_WAIT);
      }

      terminals.set(id, terminal);
      saveTerminalToDb(terminal);
      json(res, { terminal_id: id, status: 'running' });
    }],

    // Spawn plain shell terminal — backwards-compatible alias that delegates to main handler with agentType:'shell'
    [/^\/api\/terminal\/shell$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      // Inject agentType and default title, then re-use main terminal handler
      const enriched = { ...body, agentType: 'shell', title: body.title || 'Shell' };
      // Reconstruct a fake request with the enriched body
      const fakeReq = Object.create(req);
      fakeReq[Symbol.for('parsedBody')] = enriched;
      const originalParseBody = req._parsedBody;
      // Delegate by calling the main POST /api/terminal handler logic inline
      const project_key = enriched.project_key;
      if (!project_key) return err(res, 'project_key is required', 400);

      const projectPath = await resolveProjectPath(project_key);
      if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);

      const { work_item_id, epic_id, title } = enriched;
      const id = `T-${Date.now()}`;
      const adapter = getAdapter('shell');
      const shellBin = process.env.SHELL || '/bin/zsh';

      // Create EventStream and inject seed content
      const eventStream = new EventStream(id);
      await mkdir(LOGS_DIR, { recursive: true });
      const seedLines = generateSeedContent(500);
      const jsonlLines2 = [];
      for (const line of seedLines) {
        const seedEvent = eventStream.append('data', line + '\r\n', { synthetic: true });
        jsonlLines2.push(JSON.stringify(seedEvent));
      }
      try { appendFileSync(termEventLogPath(id), jsonlLines2.join('\n') + '\n'); } catch {}

      let ptyProcess;
      let tmuxName = null;
      try {
        if (TMUX_AVAILABLE) {
          tmuxName = `architect-${id}`;
          execFileSync('tmux', [
            'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24', shellBin,
          ], { cwd: projectPath });
          ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: projectPath,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
        } else {
          ptyProcess = pty.spawn(shellBin, [], {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: projectPath,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
        }
      } catch (e) {
        if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
        return json(res, { error: `Failed to spawn shell: ${e.message}` }, 500);
      }

      const terminal = {
        id,
        type: 'shell',
        agent_type: 'shell',
        work_item_id: work_item_id || null,
        epic_id: epic_id || null,
        project_key,
        project_path: projectPath,
        title: title || 'Shell',
        permission_mode: 'acceptEdits',
        skip_permissions: false,
        status: 'running',
        ptyProcess,
        pid: tmuxName
          ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
          : ptyProcess.pid,
        tmux_session: tmuxName,
        claude_session_id: null,
        agents_file: null,
        eventStream,
        wsClients: eventStream.subscribers,
        cols: 80,
        rows: 24,
        _adapter: adapter,
        _accumulated: '',
        _pendingPrompt: null,
        _readyForPrompt: true,
        started_at: new Date().toISOString(),
        exited_at: null,
      };

      wireTerminalHandlers(terminal);
      terminals.set(id, terminal);
      saveTerminalToDb(terminal);
      json(res, { terminal_id: id, status: 'running' });
    }],

    // List active terminals
    [/^\/api\/terminal\/active$/, 'GET', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      const list = [];
      for (const [id, t] of terminals) {
        if (workerId !== undefined && t._testWorkerId !== workerId) continue;
        list.push({
          id,
          type: t.type || 'claude',
          agent_type: t.agent_type || t.type || 'claude',
          work_item_id: t.work_item_id,
          epic_id: t.epic_id || null,
          project_key: t.project_key,
          project_path: t.project_path,
          title: t.title,
          status: t.status,
          started_at: t.started_at,
          exited_at: t.exited_at,
          last_output: [],
          permission_mode: t.permission_mode || 'acceptEdits',
          skip_permissions: t.skip_permissions || false,
          org_key: t.org_key || null,
          prompt: t.prompt || null,
          claude_session_id: t.claude_session_id || null,
          head_seq: t.eventStream ? t.eventStream.headSeq : 0,
        });
      }
      json(res, list);
    }],

    // Kill all terminals (must be before :id route)
    [/^\/api\/terminal\/all$/, 'DELETE', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      let killed = 0;
      for (const [, terminal] of terminals) {
        if (workerId !== undefined && terminal._testWorkerId !== workerId) continue;
        if (terminal.status !== 'running') continue;
        if (terminal.ptyProcess) {
          try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
        } else if (terminal.tmux_session && TMUX_AVAILABLE) {
          try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
        } else if (terminal.pid && isPidAlive(terminal.pid)) {
          try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
        }
        terminal.status = 'killed';
        terminal.exited_at = new Date().toISOString();
        const exitMsg = JSON.stringify({ type: 'exit', code: -1 });
        if (terminal.eventStream) {
          for (const [, sub] of terminal.eventStream.subscribers) {
            try { sub.ws.send(exitMsg); sub.ws.close(); } catch {}
          }
          terminal.eventStream.subscribers.clear();
        }
        archiveSession(terminal, 'terminal');
        saveTerminalToDb(terminal);
        unlinkFile(termEventLogPath(terminal.id)).catch(() => {});
        killed++;
      }
      json(res, { killed });
    }],

    // Kill a terminal
    [/^\/api\/terminal\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const terminal = terminals.get(m[1]);
      if (!terminal) return err(res, 'terminal not found');
      if (terminal.ptyProcess) {
        try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
      } else if (terminal.tmux_session && TMUX_AVAILABLE) {
        try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
      } else if (terminal.pid && isPidAlive(terminal.pid)) {
        try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
      }
      terminal.status = 'killed';
      terminal.exited_at = new Date().toISOString();
      const killMsg = JSON.stringify({ type: 'exit', code: -1 });
      if (terminal.eventStream) {
        for (const [, sub] of terminal.eventStream.subscribers) {
          try { sub.ws.send(killMsg); sub.ws.close(); } catch {}
        }
        terminal.eventStream.subscribers.clear();
      }
      archiveSession(terminal, 'terminal');
      if (terminal.agents_file) unlinkFile(terminal.agents_file).catch(() => {});
      terminals.delete(m[1]);
      db.deleteTerminal(m[1]);
      unlinkFile(termEventLogPath(m[1])).catch(() => {});
      json(res, { status: 'killed', id: m[1] });
    }],

    // Suspend a terminal (kill process but keep record for resume)
    [/^\/api\/terminal\/([A-Za-z0-9_-]+)\/suspend$/, 'POST', async (m, _req, res) => {
      const terminal = terminals.get(m[1]);
      if (!terminal) return err(res, 'terminal not found');
      if (terminal.status !== 'running') return err(res, 'terminal is not running', 400);
      if (terminal.ptyProcess) {
        try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
      } else if (terminal.tmux_session && TMUX_AVAILABLE) {
        try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
      } else if (terminal.pid && isPidAlive(terminal.pid)) {
        try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
      }
      terminal.status = 'suspended';
      terminal.exited_at = new Date().toISOString();
      const suspendMsg = JSON.stringify({ type: 'suspended' });
      if (terminal.eventStream) {
        for (const [, sub] of terminal.eventStream.subscribers) {
          try { sub.ws.send(suspendMsg); sub.ws.close(); } catch {}
        }
        terminal.eventStream.subscribers.clear();
      }
      terminal.ptyProcess = null;
      archiveSession(terminal, 'terminal');
      saveTerminalToDb(terminal);
      json(res, { status: 'suspended', id: m[1], claude_session_id: terminal.claude_session_id });
    }],

    // Resume a suspended terminal
    [/^\/api\/terminal\/([A-Za-z0-9_-]+)\/resume$/, 'POST', async (m, req, res) => {
      const old = terminals.get(m[1]);
      if (!old) return err(res, 'terminal not found');
      if (old.status !== 'suspended') return err(res, 'terminal is not suspended', 400);
      if (!old.claude_session_id) return err(res, 'no session ID available for resume', 400);

      const body = await parseBody(req);
      const resumeSessionId = old.claude_session_id;
      const { work_item_id, epic_id, project_key, project_path, title, permission_mode, skip_permissions } = old;

      // Remove old suspended record
      if (old.agents_file) unlinkFile(old.agents_file).catch(() => {});
      terminals.delete(m[1]);
      db.deleteTerminal(m[1]);

      // Create new terminal with --resume flag
      const id = `T-${Date.now()}`;
      const resolvedPermMode = permission_mode || 'acceptEdits';
      const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

      let ptyProcess;
      let tmuxName = null;
      try {
        const ptyArgs = ['--resume', resumeSessionId];
        if (resolvedSkipPerms) ptyArgs.push('--dangerously-skip-permissions');
        ptyArgs.push('--add-dir', ROOT);

        if (TMUX_AVAILABLE) {
          tmuxName = `architect-${id}`;
          const cliParts = [CLAUDE_BIN, ...ptyArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`)];
          const shellCmd = 'exec ' + cliParts.join(' ');
          execFileSync('tmux', [
            'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24',
            'sh', '-c', shellCmd,
          ], { cwd: project_path, env: { ...process.env, ARCHITECT_ROOT: ROOT } });
          ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: project_path,
            env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
          });
        } else {
          ptyProcess = pty.spawn(CLAUDE_BIN, ptyArgs, {
            name: 'xterm-256color', cols: 80, rows: 24,
            cwd: project_path,
            env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
          });
        }
      } catch (e) {
        if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
        return err(res, `Failed to spawn resumed terminal: ${e.message}`, 500);
      }

      const resumeEventStream = new EventStream(id);
      await mkdir(LOGS_DIR, { recursive: true });
      const resumeSeedLines = generateSeedContent(500);
      const jsonlLines3 = [];
      for (const line of resumeSeedLines) {
        const seedEvent = resumeEventStream.append('data', line + '\r\n', { synthetic: true });
        jsonlLines3.push(JSON.stringify(seedEvent));
      }
      try { appendFileSync(termEventLogPath(id), jsonlLines3.join('\n') + '\n'); } catch {}

      const terminal = {
        id,
        type: 'claude',
        agent_type: 'claude',
        work_item_id,
        epic_id,
        project_key,
        project_path,
        title: title || 'Resumed session',
        permission_mode: resolvedPermMode,
        skip_permissions: resolvedSkipPerms,
        status: 'running',
        ptyProcess,
        pid: tmuxName
          ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
          : ptyProcess.pid,
        tmux_session: tmuxName,
        claude_session_id: resumeSessionId,
        agents_file: null,
        eventStream: resumeEventStream,
        wsClients: resumeEventStream.subscribers,
        cols: 80,
        rows: 24,
        _adapter: getAdapter('claude'),
        _accumulated: '',
        _pendingPrompt: null,
        _readyForPrompt: true,
        started_at: new Date().toISOString(),
        exited_at: null,
      };

      wireTerminalHandlers(terminal);
      terminals.set(id, terminal);
      saveTerminalToDb(terminal);
      json(res, { terminal_id: id, status: 'running', resumed_from: m[1] });
    }],

    // Get EventStream events for a terminal (HTTP snapshot, for tests and reconnect)
    [/^\/api\/terminal\/([A-Za-z0-9_-]+)\/events$/, 'GET', async (m, req, res) => {
      const terminal = terminals.get(m[1]);
      if (!terminal) return err(res, 'terminal not found', 404);
      const url = new URL(req.url, 'http://localhost');
      const from = parseInt(url.searchParams.get('from') || '0', 10);
      const to = parseInt(url.searchParams.get('to') || String(terminal.eventStream.headSeq), 10);
      const { snapshot, snapshotSeq, events } = terminal.eventStream.replayFrom(from);
      const filtered = events.filter(e => e.seq <= to).slice(0, 1000);
      json(res, {
        terminal_id: terminal.id,
        head_seq: terminal.eventStream.headSeq,
        raw_bytes: terminal.eventStream.rawBytes,
        snapshot: snapshot || null,
        snapshot_seq: snapshotSeq,
        events: filtered,
      });
    }],

    // Inject a prompt into a running terminal
    [/^\/api\/terminal\/([A-Za-z0-9_-]+)\/inject$/, 'POST', async (m, req, res) => {
      const terminal = terminals.get(m[1]);
      if (!terminal) return err(res, 'terminal not found', 404);
      if (terminal.status !== 'running') return err(res, 'terminal not running', 400);
      if (terminal._pendingPrompt) return err(res, 'injection already pending', 409);

      const body = await parseBody(req);
      const { prompt } = body;
      if (!prompt) return err(res, 'prompt required', 400);

      terminal._pendingPrompt = prompt;
      terminal._readyForPrompt = true;
      await injectPrompt(terminal);
      json(res, { status: 'done' });
    }],
  ];
}
