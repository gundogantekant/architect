import { shouldCreateWorktree, checkWorktreeReadiness, isGitRepository } from '../worktree.mjs';
import { promises as fs } from 'node:fs';

export default function testEndpointRoutes(deps) {
  const {
    db, json, err, parseBody,
    ROOT, PORTFOLIO, LOGS_DIR, TMUX_AVAILABLE,
    dispatches, terminals, cliSessions,
    wireTerminalHandlers,
    broadcastDispatchLine, broadcastDispatchDone,
    buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, resolveOrgPath, loadOrgContext, loadPortfolioContext, loadResumeContext, selectAgentsForDispatch,
    saveDispatchToDb, saveTerminalToDb,
    restoreSessions,
    termEventLogPath, generateSeedContent,
    EventStream, getAdapter,
    pty,
    appendFileSync, readFileSync, writeFileSync, mkdir, unlinkFile, join,
    execFileSync,
  } = deps;

  return [
    // --- Test endpoints (for E2E test seeding) ---

    [/^\/api\/test\/explain-query$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const query = url.searchParams.get('query');
      if (query === 'approver_pending') {
        const identity = url.searchParams.get('identity') || 'probe';
        const plan = await db.explainApproverPendingQuery(identity);
        return json(res, { plan });
      }
      return err(res, `unknown query '${query}'`, 400);
    }],

    [/^\/api\/test\/seed-dispatch$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { id, status, project_key, title, work_item_id, epic_id: seedEpicId, log_lines, claude_session_id, worktree_path, worktree_branch, source_branch, pid: seedPid, dispatch_mode, agent_phase: seedAgentPhase, agent_phase_history: seedHistory } = body;
      if (!id) return err(res, 'id is required', 400);
      const _testWorkerId = req.headers['x-test-worker-id'] ?? null;

      // Write JSONL log file atomically if log_lines provided
      const logPath = join(LOGS_DIR, `${id}.jsonl`);
      if (log_lines && Array.isArray(log_lines)) {
        await mkdir(LOGS_DIR, { recursive: true });
        writeFileSync(logPath, log_lines.join('\n') + '\n');
      }

      // Load output from log file
      let output = [];
      try {
        const content = readFileSync(logPath, 'utf8');
        output = content.split('\n').filter(l => l.trim());
      } catch {}

      const resolvedStatus = status || 'completed';
      const resolvedPhase = 'agent_phase' in body ? seedAgentPhase : (resolvedStatus === 'running' ? 'generating' : null);

      const dispatch = {
        id,
        work_item_id: work_item_id || null,
        epic_id: seedEpicId || null,
        project_key: project_key || 'test/test/main',
        project_path: ROOT,
        title: title || id,
        permission_mode: 'plan',
        skip_permissions: false,
        status: resolvedStatus,
        agent_phase: resolvedPhase,
        agent_phase_history: seedHistory || [],
        claude_session_id: claude_session_id || null,
        worktree_path: worktree_path || null,
        worktree_branch: worktree_branch || null,
        source_branch: source_branch || null,
        dispatch_mode: dispatch_mode || 'standard',
        output,
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: resolvedStatus !== 'running' ? new Date().toISOString() : null,
        process: null,
        pid: seedPid || null,
        logPath,
        _testWorkerId,
      };

      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      json(res, { id, dispatch_id: id, status: dispatch.status });
    }],

    // Simulate server restart: clear memory, re-load from DB + log files
    [/^\/api\/test\/reset-sessions$/, 'POST', async (_m, _req, res) => {
      dispatches.clear();
      terminals.clear();
      await restoreSessions(wireTerminalHandlers);
      json(res, { dispatches: dispatches.size, terminals: terminals.size });
    }],

    // Build org dispatch prompt without spawning PTY (for contract tests)
    [/^\/api\/test\/build-org-prompt$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { org_key, additional_instructions } = body;
      if (!org_key) return err(res, 'org_key required', 400);
      const projectPath = await resolveOrgPath(org_key);
      if (!projectPath) return err(res, `Could not resolve org: ${org_key}`, 400);
      const orgContext = await loadOrgContext(org_key);
      const prompt = buildDispatchPrompt({
        workItem: null,
        projectKey: `${org_key}/*`,
        projectPath,
        additionalInstructions: additional_instructions || '',
        portfolio: null,
        epicContext: null,
        orgContext,
      });
      json(res, { prompt, project_path: projectPath });
    }],

    // Build auto-implement prompt without spawning (for contract/prompt tests)
    [/^\/api\/test\/build-auto-implement-prompt$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { workItem, projectKey, projectPath } = body;
      const prompt = buildAutoImplementPrompt({
        workItem: workItem || null,
        projectKey: projectKey || 'test/test/main',
        projectPath: projectPath || ROOT,
        portfolio: null,
        epicContext: null,
      });
      json(res, { prompt });
    }],

    // Seed a fake portfolio registry entry pointing to a given path (for worktree-failure tests)
    [/^\/api\/test\/seed-registry-entry$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, project_path } = body;
      if (!project_key || !project_path) return err(res, 'project_key and project_path are required', 400);
      const [org, project, component] = project_key.split('/');
      const registryPath = join(PORTFOLIO, 'registry.json');
      let registry = { entries: {} };
      try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch {}
      registry.entries[project_path] = { org, project, component };
      await mkdir(PORTFOLIO, { recursive: true });
      writeFileSync(registryPath, JSON.stringify(registry, null, 2));
      json(res, { seeded: true });
    }],

    // Seed a portfolio entry (for worktree-readiness tests)
    [/^\/api\/test\/seed-portfolio-entry$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, project_path, entry, org_entry } = body;
      if (!project_key || !entry) return err(res, 'project_key and entry required', 400);
      const [org, project, component] = project_key.split('/');
      const entryPath = join(PORTFOLIO, org, project, `${component}.json`);
      await mkdir(join(PORTFOLIO, org, project), { recursive: true });
      writeFileSync(entryPath, JSON.stringify(entry, null, 2));
      // Write organization.json: use org_entry if provided, otherwise create minimal stub if missing
      const orgJsonPath = join(PORTFOLIO, org, 'organization.json');
      if (org_entry) {
        writeFileSync(orgJsonPath, JSON.stringify(org_entry, null, 2));
      } else {
        try { readFileSync(orgJsonPath); } catch { writeFileSync(orgJsonPath, JSON.stringify({ name: org }, null, 2)); }
      }
      if (project_path) {
        const registryPath = join(PORTFOLIO, 'registry.json');
        let registry = { entries: {} };
        try { registry = JSON.parse(readFileSync(registryPath, 'utf8')); } catch {}
        registry.entries[project_path] = { org, project, component };
        writeFileSync(registryPath, JSON.stringify(registry, null, 2));
      }
      json(res, { seeded: true, entry_path: entryPath });
    }],

    // Remove a seeded portfolio entry (cleanup)
    [/^\/api\/test\/seed-portfolio-entry$/, 'DELETE', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, project_path, remove_org } = body;
      if (!project_key) return err(res, 'project_key required', 400);
      const [org, project, component] = project_key.split('/');
      const entryPath = join(PORTFOLIO, org, project, `${component}.json`);
      try { await unlinkFile(entryPath); } catch {}
      // Optionally remove the org-level organization.json (when this was the only entry for the org)
      if (remove_org) {
        try { await unlinkFile(join(PORTFOLIO, org, 'organization.json')); } catch {}
      }
      if (project_path) {
        const registryPath = join(PORTFOLIO, 'registry.json');
        try {
          const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
          delete registry.entries[project_path];
          writeFileSync(registryPath, JSON.stringify(registry, null, 2));
        } catch {}
      }
      json(res, { removed: true });
    }],

    // Test worktree readiness check logic (W-948)
    [/^\/api\/test\/worktree-readiness-check$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { portfolio_entry, project_key } = body;
      const result = checkWorktreeReadiness({
        portfolioEntry: portfolio_entry || null,
        projectKey: project_key || 'test/proj/main',
      });
      json(res, { warning_result: result });
    }],

    // Build dispatch prompt without spawning (for contract/prompt tests)
    [/^\/api\/test\/build-prompt$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { workItem, projectKey, projectPath, additionalInstructions, contract, epicContext } = body;
      const prompt = buildDispatchPrompt({
        workItem: workItem || null,
        projectKey: projectKey || 'test/test/main',
        projectPath: projectPath || ROOT,
        additionalInstructions: additionalInstructions || null,
        portfolio: null,
        epicContext: epicContext || null,
        contract: contract || null,
      });
      json(res, { prompt });
    }],

    [/^\/api\/test\/build-resume-prompt$/, 'POST', async (_m, req, res) => {
      const { workItem, contract, additionalInstructions } = await parseBody(req);
      const prompt = buildResumePrompt({ workItem: workItem || null, contract: contract || null, additionalInstructions: additionalInstructions || null });
      json(res, { prompt });
    }],

    [/^\/api\/test\/resume-args-preview$/, 'POST', async (_m, req, res) => {
      const { work_item_id, project_key } = await parseBody(req);
      const { workItem, portfolio } = await loadResumeContext({ work_item_id: work_item_id || null, project_key: project_key || null });
      const agentDefs = await selectAgentsForDispatch({ workItem, portfolio });
      json(res, { has_agents: agentDefs.length > 0, agent_count: agentDefs.length });
    }],

    // Seed a terminal with org_key support (no real PTY)
    [/^\/api\/test\/seed-org-terminal$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { org_key, additional_instructions, status: reqStatus } = body;
      if (!org_key) return err(res, 'org_key required', 400);
      const projectPath = await resolveOrgPath(org_key);
      if (!projectPath) return err(res, `Could not resolve org: ${org_key}`, 400);
      const orgContext = await loadOrgContext(org_key);
      const prompt = buildDispatchPrompt({
        workItem: null,
        projectKey: `${org_key}/*`,
        projectPath,
        additionalInstructions: additional_instructions || '',
        portfolio: null,
        epicContext: null,
        orgContext,
      });

      const id = `T-${Date.now()}`;
      await mkdir(LOGS_DIR, { recursive: true });
      const eventStream = new EventStream(id);
      const termStatus = reqStatus || 'completed';
      const terminal = {
        id,
        type: 'claude',
        agent_type: 'claude',
        work_item_id: null,
        epic_id: null,
        project_key: `${org_key}/*`,
        org_key,
        project_path: projectPath,
        prompt,
        title: additional_instructions?.slice(0, 60) || 'Org session',
        status: termStatus,
        started_at: new Date().toISOString(),
        exited_at: termStatus !== 'running' ? new Date().toISOString() : null,
        permission_mode: 'plan',
        skip_permissions: false,
        claude_session_id: null,
        ptyProcess: null,
        _skipAutoCleanup: termStatus === 'running',
        _testWorkerId: req.headers['x-test-worker-id'] ?? null,
        eventStream,
        wsClients: eventStream.subscribers,
        cols: 80,
        rows: 24,
        tmux_session: null,
      };
      terminals.set(id, terminal);
      await saveTerminalToDb(terminal);
      json(res, { terminal_id: id, status: terminal.status, project_path: projectPath, prompt });
    }],

    // Seed a session_history entry (for time report tests)
    [/^\/api\/test\/seed-session-history$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { id: seedId, project_key, duration_seconds, cost_usd, started_at, ended_at } = body;
      if (!project_key) return err(res, 'project_key is required', 400);
      const end = ended_at || new Date().toISOString();
      const dur = duration_seconds || 300;
      const start = started_at || new Date(new Date(end).getTime() - dur * 1000).toISOString();
      const id = seedId || `SH-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await db.recordSessionHistory({
        id,
        type: 'test',
        project_key,
        work_item_id: null,
        epic_id: null,
        title: 'Test session',
        status: 'completed',
        permission_mode: 'plan',
        started_at: start,
        ended_at: end,
        cost_usd: cost_usd ?? 0,
      });
      json(res, { ok: true, id });
    }],

    // Purge all sessions from memory AND DB (for test isolation)
    [/^\/api\/test\/purge-all$/, 'POST', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];

      if (workerId === undefined) {
        // Global purge — no worker header means global-setup.mjs or manual call; clear everything.
        const deleteDispatchPromises = [];
        for (const [id, d] of dispatches) {
          if (d.process) try { d.process.kill('SIGKILL'); } catch {}
          if (d._tailInterval) clearInterval(d._tailInterval);
          if (d.logStream) try { d.logStream.end(); } catch {}
          broadcastDispatchDone(d);
          deleteDispatchPromises.push(db.deleteDispatch(id));
        }
        const ptyExitPromises = [];
        const deleteTerminalPromises = [];
        for (const [id, t] of terminals) {
          if (t.ptyProcess) {
            ptyExitPromises.push(new Promise(r => { t.ptyProcess.onExit(() => r()); setTimeout(r, 2000); }));
            try { t.ptyProcess.kill('SIGHUP'); } catch {}
          }
          if (t.tmux_session && TMUX_AVAILABLE) try { execFileSync('tmux', ['kill-session', '-t', t.tmux_session], { stdio: 'ignore' }); } catch {}
          if (t.eventStream) {
            for (const [, sub] of t.eventStream.subscribers) { try { sub.ws.close(); } catch {} }
            t.eventStream.subscribers.clear();
          }
          deleteTerminalPromises.push(db.deleteTerminal(id));
        }
        // Wait for PTY processes to fully exit (max 2s) and DB deletes before responding
        if (ptyExitPromises.length > 0) await Promise.all(ptyExitPromises);
        await Promise.all([...deleteDispatchPromises, ...deleteTerminalPromises]);
        dispatches.clear();
        terminals.clear();
        // Hard-delete all epics and work items created during tests
        await db.hardDeleteAllTestData();
        // Note: registry.json is NOT restored here — it is shared across parallel test servers
        // and parallel purge-all calls would race and wipe entries seeded by other servers.
      } else {
        // Worker-scoped purge — delete terminals and dispatches belonging to this worker.
        const toDeleteTerminals = [];
        const workerPtyExits = [];
        const workerDeleteTerminalPromises = [];
        for (const [id, t] of terminals) {
          if (t._testWorkerId !== workerId) continue;
          if (t.ptyProcess) {
            workerPtyExits.push(new Promise(r => { t.ptyProcess.onExit(() => r()); setTimeout(r, 2000); }));
            try { t.ptyProcess.kill('SIGHUP'); } catch {}
          }
          if (t.tmux_session && TMUX_AVAILABLE) try { execFileSync('tmux', ['kill-session', '-t', t.tmux_session], { stdio: 'ignore' }); } catch {}
          if (t.eventStream) {
            for (const [, sub] of t.eventStream.subscribers) { try { sub.ws.close(); } catch {} }
            t.eventStream.subscribers.clear();
          }
          workerDeleteTerminalPromises.push(db.deleteTerminal(id));
          toDeleteTerminals.push(id);
        }
        if (workerPtyExits.length > 0) await Promise.all(workerPtyExits);
        await Promise.all(workerDeleteTerminalPromises);
        for (const id of toDeleteTerminals) terminals.delete(id);

        // Worker-scoped dispatch purge — only delete dispatches belonging to this worker.
        const toDeleteDispatches = [];
        const workerDeleteDispatchPromises = [];
        for (const [id, d] of dispatches) {
          if (d._testWorkerId !== workerId) continue;
          if (d.process) try { d.process.kill('SIGKILL'); } catch {}
          if (d._tailInterval) clearInterval(d._tailInterval);
          if (d.logStream) try { d.logStream.end(); } catch {}
          broadcastDispatchDone(d);
          workerDeleteDispatchPromises.push(db.deleteDispatch(id));
          toDeleteDispatches.push(id);
        }
        await Promise.all(workerDeleteDispatchPromises);
        for (const id of toDeleteDispatches) dispatches.delete(id);
      }

      json(res, { purged: true });
    }],

    // Append output to a running dispatch (simulates wireDispatchHandlers without Claude)
    [/^\/api\/test\/append-dispatch-output$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { id, lines } = body;
      if (!id || !lines) return err(res, 'id and lines required', 400);
      const dispatch = dispatches.get(id);
      if (!dispatch) return err(res, 'dispatch not found');

      const logPath = join(LOGS_DIR, `${id}.jsonl`);
      for (const line of lines) {
        dispatch.output.push(line);
        appendFileSync(logPath, line + '\n');
        broadcastDispatchLine(dispatch, line);
      }
      json(res, { appended: lines.length });
    }],

    // Seed a terminal with EventStream content (no real PTY)
    [/^\/api\/test\/seed-terminal$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { scrollback, status, claude_session_id, lines, withFakeContent, withInjectionEvents, ansiColors, agentType: bodyAgentType, work_item_id, epic_id } = body;
      const agentType = bodyAgentType || 'shell';
      const workerId = req.headers['x-test-worker-id'];
      const id = body.id || (workerId !== undefined ? `T-${Date.now()}-${workerId}` : `T-${Date.now()}`);

      await mkdir(LOGS_DIR, { recursive: true });
      const eventStream = new EventStream(id);

      // Support legacy scrollback field for backwards compatibility
      if (scrollback) {
        const event = eventStream.append('data', scrollback);
        try { appendFileSync(termEventLogPath(id), JSON.stringify(event) + '\n'); } catch {}
      }

      // Generate fake content if requested
      if (withFakeContent) {
        const fakeLines = generateSeedContent(lines || 200);
        for (const line of fakeLines) {
          const event = eventStream.append('data', line + '\r\n', { synthetic: true });
          try { appendFileSync(termEventLogPath(id), JSON.stringify(event) + '\n'); } catch {}
        }
      }

      // Inject claude session ID meta event if provided
      if (claude_session_id) {
        const metaEvent = eventStream.append('meta', { key: 'claude_session_id', value: claude_session_id });
        try { appendFileSync(termEventLogPath(id), JSON.stringify(metaEvent) + '\n'); } catch {}
      }

      // Inject prompt injection lifecycle events if requested
      if (withInjectionEvents) {
        for (const val of ['injecting', 'done']) {
          const evt = eventStream.append('meta', { key: 'prompt_injection_status', value: val });
          try { appendFileSync(termEventLogPath(id), JSON.stringify(evt) + '\n'); } catch {}
        }
      }

      const terminalStatus = status || 'completed';
      const terminal = {
        id,
        type: agentType,
        agent_type: agentType,
        work_item_id: work_item_id || null,
        epic_id: epic_id || null,
        project_key: 'test/test/main',
        project_path: ROOT,
        title: `Test terminal ${id}`,
        status: terminalStatus,
        started_at: new Date().toISOString(),
        exited_at: terminalStatus !== 'running' ? new Date().toISOString() : null,
        permission_mode: 'plan',
        skip_permissions: false,
        claude_session_id: claude_session_id || null,
        ptyProcess: null,
        // In-memory flag: skip auto-cleanup for test-seeded running terminals (no real PTY/pid/tmux)
        _skipAutoCleanup: terminalStatus === 'running',
        _testWorkerId: workerId ?? null,
        eventStream,
        wsClients: eventStream.subscribers,
        cols: 80,
        rows: 24,
        tmux_session: null,
      };

      terminals.set(id, terminal);
      await saveTerminalToDb(terminal);
      json(res, { terminal_id: id, status: terminal.status });
    }],

    // Pump live events into a seeded terminal
    [/^\/api\/test\/seed-terminal\/pump$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { terminalId, linesPerSecond = 2, duration = 10 } = body;
      const terminal = terminals.get(terminalId);
      if (!terminal) return err(res, 'terminal not found', 404);

      const intervalMs = Math.floor(1000 / linesPerSecond);
      let count = 0;
      const maxLines = linesPerSecond * duration;

      const iv = setInterval(() => {
        if (count >= maxLines || terminal.status !== 'running') {
          clearInterval(iv);
          return;
        }
        const line = `pump-line-${count++} ts=${Date.now()}\r\n`;
        const event = terminal.eventStream.append('data', line);
        try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(event) + '\n'); } catch {}
        terminal.eventStream.broadcast(event);
      }, intervalMs);

      json(res, { status: 'pumping', terminalId, linesPerSecond, duration });
    }],

    // Return full EventStream state for a terminal (test inspection)
    [/^\/api\/test\/terminal\/([A-Za-z0-9_-]+)\/event-stream$/, 'GET', async (m, _req, res) => {
      const terminal = terminals.get(m[1]);
      if (!terminal) return err(res, 'terminal not found', 404);
      json(res, {
        terminal_id: terminal.id,
        head_seq: terminal.eventStream.headSeq,
        raw_bytes: terminal.eventStream.rawBytes,
        snapshot: terminal.eventStream.snapshot,
        snapshot_seq: terminal.eventStream.snapshotSeq,
        live_snapshot_length: terminal.eventStream.liveSnapshot.length,
        events: terminal.eventStream.events,
      });
    }],

    // Test endpoint: spawn a real PTY terminal with a large prompt written to it,
    // simulating the exact dispatch flow. Returns the terminal ID so a browser
    // can connect via WS and verify content delivery.
    [/^\/api\/test\/spawn-prompt-terminal$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { payload } = body;
      if (!payload) return err(res, 'payload is required', 400);

      const id = `T-test-prompt-${Date.now()}`;

      // Spawn cat in a PTY — it echoes all input, simulating Claude receiving a prompt
      let ptyProcess;
      try {
        ptyProcess = pty.spawn('cat', [], {
          name: 'xterm-256color', cols: 120, rows: 24,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      } catch (e) {
        return json(res, { error: `Failed to spawn: ${e.message}` }, 500);
      }

      const promptEventStream = new EventStream(id);
      const terminal = {
        id, type: 'claude', agent_type: 'claude', work_item_id: null, epic_id: null,
        project_key: 'test/test/main', project_path: ROOT,
        title: `Prompt delivery test ${id}`,
        status: 'running', ptyProcess, pid: ptyProcess.pid,
        tmux_session: null, claude_session_id: null,
        agents_file: null,
        eventStream: promptEventStream,
        wsClients: promptEventStream.subscribers,
        cols: 120, rows: 24,
        _adapter: getAdapter('claude'),
        _accumulated: '',
        _pendingPrompt: null,
        _readyForPrompt: true,
        started_at: new Date().toISOString(), exited_at: null,
        permission_mode: 'plan', skip_permissions: false,
      };

      wireTerminalHandlers(terminal);
      terminals.set(id, terminal);
      await saveTerminalToDb(terminal);

      // Write prompt using same chunked method — this runs ASYNC while client connects
      const CHUNK_SIZE = 1024;
      const CHUNK_DELAY = 100;
      (async () => {
        ptyProcess.write('\x1b[200~');
        for (let i = 0; i < payload.length; i += CHUNK_SIZE) {
          ptyProcess.write(payload.slice(i, i + CHUNK_SIZE));
          if (i + CHUNK_SIZE < payload.length) {
            await new Promise(r => setTimeout(r, CHUNK_DELAY));
          }
        }
        ptyProcess.write('\x1b[201~');
        ptyProcess.write('\r');
        // Send EOF after prompt is fully written + settle time
        await new Promise(r => setTimeout(r, 500));
        ptyProcess.write('\x04');
      })();

      json(res, { terminal_id: id, status: 'running', payload_length: payload.length });
    }],

    // Test endpoint: spawn a child process with stdin pipe (same as dispatch),
    // write a large payload, and verify the process received all of it.
    [/^\/api\/test\/stdin-delivery$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { payload } = body;
      if (!payload) return err(res, 'payload is required', 400);

      // Spawn wc -c to count bytes received on stdin
      const { spawn: spawnChild } = await import('child_process');
      const proc = spawnChild('wc', ['-c'], { stdio: ['pipe', 'pipe', 'pipe'] });

      let stdout = '';
      proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });

      // Use same backpressure-aware write as dispatch
      if (!proc.stdin.write(payload)) {
        await new Promise(r => proc.stdin.once('drain', r));
      }
      proc.stdin.end();

      const exitCode = await new Promise(r => proc.on('close', r));
      const receivedBytes = parseInt(stdout.trim(), 10);

      json(res, {
        payload_length: payload.length,
        received_bytes: receivedBytes,
        match: receivedBytes === payload.length,
        exit_code: exitCode,
      });
    }],

    // Test endpoint: spawn a real PTY (cat), write a large payload using the same
    // chunked delivery, wait for echo, and return captured output for verification.
    [/^\/api\/test\/prompt-delivery$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { payload, chunk_size, chunk_delay } = body;
      if (!payload) return err(res, 'payload is required', 400);

      const CHUNK = chunk_size || 1024;
      const DELAY = chunk_delay || 100;

      // Spawn cat in a PTY — it echoes all input back
      let ptyProc;
      try {
        ptyProc = pty.spawn('cat', [], {
          name: 'xterm-256color', cols: 200, rows: 24,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      } catch (e) {
        return json(res, { error: `Failed to spawn cat: ${e.message}` }, 500);
      }

      let captured = '';
      ptyProc.onData((data) => { captured += data; });

      // Write payload using same chunked + bracketed paste method as real terminals
      ptyProc.write('\x1b[200~');
      for (let i = 0; i < payload.length; i += CHUNK) {
        const chunk = payload.slice(i, i + CHUNK);
        ptyProc.write(chunk);
        if (i + CHUNK < payload.length) {
          await new Promise(r => setTimeout(r, DELAY));
        }
      }
      ptyProc.write('\x1b[201~');
      ptyProc.write('\r');

      // Wait for echo to settle, then send EOF to cat
      const settleDelay = Math.max(500, Math.ceil(payload.length / CHUNK) * DELAY + 500);
      await new Promise(r => setTimeout(r, settleDelay));

      // Send Ctrl+D (EOF) to terminate cat
      ptyProc.write('\x04');
      await new Promise(r => setTimeout(r, 200));

      try { ptyProc.kill(); } catch {}

      // Strip ANSI escape sequences and bracketed paste markers from captured output
      const clean = captured
        .replace(/\x1b\[[0-9;]*[a-zA-Z~]/g, '')  // ANSI CSI sequences
        .replace(/\x1b\].*?\x07/g, '')            // OSC sequences
        .replace(/\r/g, '')                        // carriage returns
        .replace(/\x04/g, '');                     // EOF chars

      json(res, {
        payload_length: payload.length,
        captured_length: clean.length,
        captured_raw_length: captured.length,
        // Check if every line from the payload appears in the captured output
        lines_sent: payload.split('\n').filter(l => l.trim()).length,
        lines_captured: clean.split('\n').filter(l => l.trim()).length,
        // Return first/last 500 chars for debugging
        head: clean.slice(0, 500),
        tail: clean.slice(-500),
        // Return markers for specific content verification
        contains_start: clean.includes(payload.slice(0, 50)),
        contains_end: clean.includes(payload.slice(-50)),
      });
    }],

    // Test worktree decision logic (W-927, updated W-958)
    // Accepts project_path (new) or is_git boolean (backward compat: true→ROOT, false→/tmp).
    // NOTE: ROOT must be a git repository for backward-compat mapping of is_git: true to work.
    [/^\/api\/test\/worktree-decision$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { permission_mode, work_item_id, worktree_mode, feature_flag, project_path, is_git } = body;
      const effectivePath = project_path !== undefined ? project_path
        : is_git === true ? ROOT
        : is_git === false ? '/tmp'
        : null;
      const result = await shouldCreateWorktree({
        permissionMode: permission_mode,
        workItemId: work_item_id,
        portfolioEntry: worktree_mode ? { worktree_mode } : null,
        featureFlag: feature_flag !== false,
        projectPath: effectivePath,
      });
      json(res, { should_create: result });
    }],

    // Test isGitRepository error path resilience (W-954)
    [/^\/api\/test\/is-git-repository$/, 'POST', async (_m, req, res) => {
      const { path: testPath } = await parseBody(req);
      if (!testPath) return err(res, 'path is required', 400);
      const result = await isGitRepository(testPath);
      json(res, { is_git: result });
    }],

    // Test utility: return server ROOT path (a known git repository) for integration tests
    [/^\/api\/test\/root-path$/, 'GET', (_m, _req, res) => {
      json(res, { root: ROOT });
    }],

    // Diagnostic: return current PORTFOLIO path (for PP-1 test)
    [/^\/api\/_diag\/portfolio-path$/, 'GET', async (_m, _req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: deps.PORTFOLIO }));
    }],

    // Test prompt builder with worktree context (W-927)
    [/^\/api\/test\/build-dispatch-prompt$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { project_key, work_item, worktree_context } = body;
      const portfolio = await loadPortfolioContext(project_key).catch(() => null);
      const prompt = buildDispatchPrompt({
        workItem: work_item,
        projectKey: project_key,
        projectPath: ROOT,
        portfolio,
        worktreeContext: worktree_context || null,
      });
      json(res, { prompt });
    }],

    // POST /_test/seed-portfolio — create a minimal portfolio entry and registry row for detach contract tests
    [/^\/_test\/seed-portfolio$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { org, project, component, path: projectPath } = body;
      if (!org || !project || !component) return err(res, 'org, project, and component are required', 400);
      const portfolioKey = `${org}/${project}/${component}`;
      const portDir = join(PORTFOLIO, org, project);
      await fs.mkdir(portDir, { recursive: true });
      await fs.writeFile(
        join(portDir, component + '.json'),
        JSON.stringify({ name: project, role: 'app', path: projectPath || `/tmp/${project}`, org_key: org, project_key: portfolioKey })
      );
      const regPath = join(PORTFOLIO, 'registry.json');
      let registry = {};
      try { registry = JSON.parse(await fs.readFile(regPath, 'utf8')); } catch {}
      if (projectPath) registry[projectPath] = portfolioKey;
      await fs.writeFile(regPath, JSON.stringify(registry, null, 2));
      json(res, { ok: true, portfolio_key: portfolioKey });
    }],

    // POST /_test/seed-dispatch — create a minimal dispatch for detach conflict tests (auto-generates ID)
    [/^\/_test\/seed-dispatch$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const id = `D-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const resolvedStatus = body.status || 'running';
      const dispatch = {
        id,
        work_item_id: null,
        epic_id: null,
        project_key: body.project_key || 'test/test/main',
        project_path: ROOT,
        title: id,
        permission_mode: 'plan',
        skip_permissions: false,
        status: resolvedStatus,
        agent_phase: resolvedStatus === 'running' ? 'generating' : null,
        agent_phase_history: [],
        contract: body.contract || null,
        claude_session_id: null,
        worktree_path: null,
        worktree_branch: null,
        source_branch: null,
        dispatch_mode: 'standard',
        timeout_at: body.timeout_at || null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: resolvedStatus !== 'running' ? new Date().toISOString() : null,
        process: null,
        pid: null,
        logPath: join(LOGS_DIR, `${id}.jsonl`),
        _testWorkerId: req.headers['x-test-worker-id'] ?? null,
      };
      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      json(res, { id, dispatch_id: id, status: dispatch.status });
    }],
  ];
}
