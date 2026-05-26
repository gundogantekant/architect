/**
 * Shared module for spawning a claude-agent PTY terminal session.
 * Extracted from routes/terminal.mjs POST /api/terminal (claude agentType only).
 *
 * @param {object} deps - Injected dependencies from server.mjs deps object
 * @param {object} params - Session parameters
 * @param {string} params.id - Unique session ID (e.g. `T-${Date.now()}`)
 * @param {string} params.projectPath - Working directory for the PTY process
 * @param {string} params.prompt - Prompt to inject once claude is ready
 * @param {Array}  params.agentDefs - Sub-agent definitions array (may be empty)
 * @param {string} params.permissionMode - 'plan' | 'acceptEdits' | etc.
 * @param {boolean} params.skipPermissions - Whether to pass --dangerously-skip-permissions
 * @param {string|null} params.workItemId
 * @param {string|null} params.epicId
 * @param {string|null} params.projectKey
 * @param {string|null} params.orgKey
 * @param {string}  params.title - Human-readable session title
 * @param {string|null} params.testWorkerId - x-test-worker-id header value
 * @param {boolean} params.skip_seed - Skip seed content injection when true
 * @returns {Promise<object>} Terminal object (already wired, registered in Map, saved to DB)
 * @throws {Error} On PTY spawn failure — caller must catch and return 500
 */
export async function spawnTerminalSession(deps, params) {
  const {
    ROOT, PORTFOLIO, CLAUDE_BIN, TMUX_AVAILABLE, LOGS_DIR,
    wireTerminalHandlers, injectPrompt,
    terminals, saveTerminalToDb, termEventLogPath, generateSeedContent,
    EventStream, getAdapter,
    pty,
    appendFileSync, unlinkFile, mkdir, join, execFileSync, writeFileSync,
  } = deps;

  const {
    id, projectPath, prompt, agentDefs = [], permissionMode = 'acceptEdits',
    skipPermissions = false, workItemId = null, epicId = null,
    projectKey = null, orgKey = null, title = 'Interactive session',
    testWorkerId = null, skip_seed = false,
  } = params;

  const adapter = getAdapter('claude');
  const claudeSessionId = crypto.randomUUID();

  // Create EventStream and optionally inject seed content before PTY starts
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

  const ptyArgs = adapter.buildArgs(claudeSessionId, {
    permissionMode,
    skipPermissions,
    addDir: ROOT,
    agentsJson: null,
    model: 'sonnet',
  });

  let ptyProcess;
  let tmuxName = null;
  let agentsFile = null;

  try {
    if (agentDefs.length) {
      if (TMUX_AVAILABLE) {
        const tmpDir = join(ROOT, 'tmp');
        try { await mkdir(tmpDir, { recursive: true }); } catch {}
        agentsFile = join(tmpDir, `agents-${id}.json`);
        writeFileSync(agentsFile, JSON.stringify(agentDefs));
      } else {
        ptyArgs.push('--agents', JSON.stringify(agentDefs));
      }
    }

    if (TMUX_AVAILABLE) {
      tmuxName = `architect-${id}`;
      const cliParts = [CLAUDE_BIN, ...ptyArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`)];
      if (agentsFile) cliParts.push('--agents', `"$(cat '${agentsFile}')"`);
      const shellCmd = 'exec ' + cliParts.join(' ');
      execFileSync('tmux', [
        'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24',
        'sh', '-c', shellCmd,
      ], { cwd: projectPath, env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO } });
      try { execFileSync('tmux', ['set-option', '-t', tmuxName, '-g', 'mouse', 'on']); } catch {}
      ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: projectPath,
        env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
      });
    } else {
      ptyProcess = pty.spawn(CLAUDE_BIN, ptyArgs, {
        name: 'xterm-256color', cols: 80, rows: 24,
        cwd: projectPath,
        env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
      });
    }

    ptyProcess.on('error', (e) => {
      console.error(JSON.stringify({ type: 'pty_error', errno: e.code, message: e.message, pid: ptyProcess.pid, session_id: id, timestamp: new Date().toISOString() }));
    });
  } catch (spawnErr) {
    if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
    if (agentsFile) { try { unlinkFile(agentsFile); } catch {} }
    throw spawnErr;
  }

  // TODO: split point if LOC budget becomes a constraint — extract terminal object
  //       construction + handler wiring into a buildTerminalRecord(params) helper.
  const terminal = {
    id,
    type: 'claude',
    agent_type: 'claude',
    work_item_id: workItemId,
    epic_id: epicId,
    project_key: projectKey || (orgKey ? `${orgKey}/*` : null),
    org_key: orgKey,
    project_path: projectPath,
    prompt,
    title,
    permission_mode: permissionMode,
    skip_permissions: skipPermissions,
    status: 'running',
    ptyProcess,
    pid: tmuxName
      ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
      : ptyProcess.pid,
    tmux_session: tmuxName,
    claude_session_id: claudeSessionId,
    agents_file: agentsFile,
    eventStream,
    wsClients: eventStream.subscribers,
    cols: 80,
    rows: 24,
    _adapter: adapter,
    _accumulated: '',
    _pendingPrompt: prompt,
    _readyForPrompt: false,
    _permissionMode: permissionMode,
    _skipPermissions: skipPermissions,
    _testWorkerId: testWorkerId,
    started_at: new Date().toISOString(),
    exited_at: null,
  };

  // Wire handlers BEFORE returning — required constraint
  wireTerminalHandlers(terminal);

  // Fallback: inject prompt if readiness detection never fires.
  // If injection fails, injectPrompt kills the session and emits session_status:failed —
  // this path inherits that kill-on-failure behavior automatically; no separate handling needed.
  const MAX_WAIT = tmuxName ? 8000 : 5000;
  setTimeout(() => {
    if (terminal._pendingPrompt && terminal.ptyProcess) {
      terminal._readyForPrompt = true;
      injectPrompt(terminal);
    }
  }, MAX_WAIT);

  terminals.set(id, terminal);
  await saveTerminalToDb(terminal);

  return terminal;
}
