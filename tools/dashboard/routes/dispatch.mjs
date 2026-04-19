import { existsSync } from 'node:fs';
import { createWorktreeForDispatch, shouldCreateWorktree } from '../worktree.mjs';

/**
 * Find an active (running) dispatch for a given work item ID.
 * Returns the dispatch object or null.
 */
function findActiveDispatchForWorkItem(dispatches, workItemId) {
  for (const d of dispatches.values()) {
    if (d.work_item_id === workItemId && d.status === 'running') return d;
  }
  return null;
}

/**
 * Resolve which dependency IDs are not yet in 'done' status.
 * Returns array of unmet dependency IDs.
 */
function resolveUnmetDependencies(db, dependsOn) {
  if (!dependsOn || !dependsOn.length) return [];
  return dependsOn.filter(depId => {
    const dep = db.getWorkItemFull(depId);
    return !dep || dep.status !== 'done';
  });
}

/**
 * Create a worktree for an auto-implement dispatch (always creates, ignores worktree_mode).
 * Returns worktree context. Throws on failure — callers must handle with 500.
 */
async function createWorktreeForAutoImplement({ projectPath, workItem }) {
  return await createWorktreeForDispatch({
    projectPath,
    portfolioEntry: null,
    workItemId: workItem.id,
    workItemTitle: workItem.title || workItem.id,
    orgConventions: null,
  });
}

export default function dispatchRoutes(deps) {
  const {
    db, json, err, parseBody,
    ROOT, LOGS_DIR, CLAUDE_BIN,
    dispatches,
    wireDispatchHandlers,
    buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, resolveProjectPath, loadPortfolioContext, loadWorkItem, loadResumeContext, selectAgentsForDispatch, loadEpicPlanSnippet,
    broadcastDispatchLine, broadcastDispatchDone, killProcessGraceful,
    saveDispatchToDb, archiveSession,
    isPidAlive,
    spawn, createWriteStream, unlinkFile, join,
  } = deps;
  return [
    // --- Onboard endpoint ---
    [/^\/api\/onboard$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { path: projectPath, organization } = body;
      if (!projectPath) return err(res, 'path is required', 400);

      const id = `D-${Date.now()}`;
      let prompt = `/onboard ${projectPath}`;
      if (organization) prompt += ` --organization ${organization}`;

      const dispatch = {
        id,
        work_item_id: null,
        epic_id: null,
        project_key: 'onboard',
        project_path: projectPath,
        title: `Onboard: ${projectPath.split('/').pop()}`,
        permission_mode: 'acceptEdits',
        status: 'running',
        agent_phase: 'generating',
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      let proc;
      try {
        proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose'], {
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT },
        });
      } catch (err) {
        return json(res, { error: `Failed to spawn claude: ${err.message}` }, 500);
      }

      // Write prompt with backpressure handling to prevent truncation on large prompts
      if (!proc.stdin.write(prompt)) {
        await new Promise(r => proc.stdin.once('drain', r));
      }
      proc.stdin.end();

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      dispatches.set(id, dispatch);
      saveDispatchToDb(dispatch);
      json(res, { dispatch_id: id, status: 'running' });
    }],

    // --- Dispatch endpoints ---

    // Create dispatch
    [/^\/api\/dispatch$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions, permission_mode, contract: rawContract } = body;

      // Strip empty-string contract fields per domain/rules.md → Dispatch Contract Rules
      let contract = null;
      if (rawContract && typeof rawContract === 'object') {
        const cleaned = {};
        for (const [k, v] of Object.entries(rawContract)) {
          if (k === 'stop_conditions') {
            if (Array.isArray(v) && v.filter(s => typeof s === 'string' && s.trim()).length) {
              cleaned[k] = v.filter(s => typeof s === 'string' && s.trim());
            }
          } else if (typeof v === 'string' && v.trim()) {
            cleaned[k] = v;
          }
        }
        contract = Object.keys(cleaned).length ? cleaned : null;
      }

      if (!project_key) {
        return err(res, 'project_key is required', 400);
      }
      if (!work_item_id && !additional_instructions) {
        return err(res, 'work_item_id or additional_instructions is required', 400);
      }

      const projectPath = await resolveProjectPath(project_key);
      if (!projectPath) {
        return err(res, `Could not resolve path for project: ${project_key}`, 400);
      }

      const id = `D-${Date.now()}`;

      const [portfolio, workItem] = await Promise.all([
        loadPortfolioContext(project_key),
        work_item_id ? loadWorkItem(work_item_id) : null,
      ]);

      let epicContext = null;
      if (epic_id) {
        try {
          const epicFull = db.getEpicFull(epic_id);
          if (epicFull) {
            const planSnippet = await loadEpicPlanSnippet(epic_id);
            epicContext = {
              id: epicFull.id,
              title: epicFull.title,
              status: epicFull.status,
              progress: `${epicFull.progress.done}/${epicFull.progress.total}`,
              acceptance_criteria: epicFull.acceptance_criteria,
              items: epicFull.resolved_items,
              plan_snippet: planSnippet,
            };
          }
        } catch {}
      }

      // Load related project contexts for epic dispatches
      let relatedProjects = null;
      if (epicContext && epicContext.items) {
        const relatedKeys = [...new Set(epicContext.items.map(i => i.project_key))].filter(k => k !== project_key);
        if (relatedKeys.length) {
          relatedProjects = (await Promise.all(
            relatedKeys.map(async k => {
              const ctx = await loadPortfolioContext(k);
              return ctx ? { key: k, entry: ctx.entry } : null;
            })
          )).filter(Boolean);
        }
      }

      const effectiveWorkItem = workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null);

      // Resolve permission mode and skip_permissions independently
      const resolvedPermMode = permission_mode || 'acceptEdits';
      const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

      // --- Dispatch-level worktree creation (W-927) ---
      const featureFlag = (db.getPreference('worktree_at_dispatch') ?? 'true') === 'true';
      const rawEntry = portfolio?.entry || null;
      let worktreeContext = null;
      let effectiveCwd = projectPath;

      if (shouldCreateWorktree({ permissionMode: resolvedPermMode, workItemId: work_item_id, portfolioEntry: rawEntry, featureFlag })) {
        try {
          worktreeContext = await createWorktreeForDispatch({
            projectPath,
            portfolioEntry: rawEntry,
            workItemId: work_item_id,
            workItemTitle: title || effectiveWorkItem?.title || '',
            orgConventions: portfolio?.org,
          });
          effectiveCwd = worktreeContext.worktreePath;
        } catch (wtErr) {
          return err(res, `Worktree creation failed: ${wtErr.message}`, 500);
        }
      }

      const prompt = buildDispatchPrompt({
        workItem: effectiveWorkItem,
        projectKey: project_key,
        projectPath,
        additionalInstructions: additional_instructions,
        portfolio,
        epicContext,
        relatedProjects,
        worktreeContext,
        contract: contract && Object.keys(contract).length ? contract : null,
      });

      // Select sub-agents based on work item and portfolio context
      const agentDefs = await selectAgentsForDispatch({ workItem: effectiveWorkItem, portfolio });

      const dispatch = {
        id,
        work_item_id,
        epic_id: epic_id || null,
        project_key,
        project_path: projectPath,
        title: title || work_item_id || '',
        permission_mode: resolvedPermMode,
        skip_permissions: resolvedSkipPerms,
        status: 'running',
        agent_phase: 'generating',
        claude_session_id: null,
        worktree_path: worktreeContext?.worktreePath || null,
        worktree_branch: worktreeContext?.branchName || null,
        source_branch: worktreeContext?.sourceBranch || null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      let proc;
      try {
        const args = ['-p', '--output-format', 'stream-json', '--verbose'];
        args.push('--permission-mode', resolvedPermMode === 'plan' ? 'plan' : 'acceptEdits');
        if (resolvedSkipPerms) {
          args.push('--dangerously-skip-permissions');
        }
        // Give the agent access to the architect project directory
        args.push('--add-dir', ROOT);
        // Attach curated sub-agents
        if (agentDefs.length) {
          args.push('--agents', JSON.stringify(agentDefs));
        }
        proc = spawn(CLAUDE_BIN, args, {
          cwd: effectiveCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT },
        });
      } catch (spawnErr) {
        return json(res, { error: `Failed to spawn claude: ${spawnErr.message}` }, 500);
      }

      // Write prompt with backpressure handling to prevent truncation on large prompts
      if (!proc.stdin.write(prompt)) {
        await new Promise(r => proc.stdin.once('drain', r));
      }
      proc.stdin.end();

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      dispatches.set(id, dispatch);
      saveDispatchToDb(dispatch);
      json(res, { dispatch_id: id, status: 'running' });
    }],

    // Auto-implement: autonomous end-to-end implementation dispatch
    [/^\/api\/dispatch\/auto-implement$/, 'POST', async (_m, req, res) => {
      const depth = parseInt(req.headers['x-architect-session-depth'] || '0', 10);
      if (depth >= 1) {
        return err(res, 'Auto-implement cannot be triggered from within a dispatch agent (depth ≥ 1).', 403);
      }

      const body = await parseBody(req);
      const { work_item_id, project_key, additional_instructions } = body;

      if (!work_item_id) return err(res, 'work_item_id is required', 400);
      if (!project_key) return err(res, 'project_key is required', 400);

      const workItem = await loadWorkItem(work_item_id);
      if (!workItem) return err(res, `Work item ${work_item_id} not found`, 404);

      const allowedStatuses = ['open', 'ready', 'in-progress'];
      if (!allowedStatuses.includes(workItem.status)) {
        return err(res, `Work item status '${workItem.status}' cannot be auto-implemented. Must be open, ready, or in-progress.`, 400);
      }

      const unmetDeps = resolveUnmetDependencies(db, workItem.depends_on || []);
      if (unmetDeps.length) {
        return err(res, `Unmet dependencies: ${unmetDeps.join(', ')}. Resolve these before auto-implementing.`, 400);
      }

      const existingDispatch = findActiveDispatchForWorkItem(dispatches, work_item_id);
      if (existingDispatch) {
        return err(res, `A dispatch is already running for this work item.`, 400);
      }

      const projectPath = await resolveProjectPath(project_key);
      if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);

      const id = `D-${Date.now()}`;

      let portfolio, worktreeContext;
      try {
        [portfolio, worktreeContext] = await Promise.all([
          loadPortfolioContext(project_key),
          createWorktreeForAutoImplement({ projectPath, workItem }),
        ]);
      } catch (worktreeErr) {
        return err(res, `Failed to create worktree: ${worktreeErr.message}`, 500);
      }

      const effectiveWorkItem = { ...workItem, additional_instructions: additional_instructions || null };

      const prompt = buildAutoImplementPrompt({
        workItem: effectiveWorkItem,
        projectKey: project_key,
        projectPath,
        additionalInstructions: additional_instructions || null,
        portfolio,
        epicContext: null,
      });

      const agentDefs = await selectAgentsForDispatch({ workItem: effectiveWorkItem, portfolio });

      const effectiveCwd = worktreeContext?.worktreePath || projectPath;

      const dispatch = {
        id,
        work_item_id,
        epic_id: null,
        project_key,
        project_path: projectPath,
        title: workItem.title || work_item_id,
        permission_mode: 'acceptEdits',
        skip_permissions: true,
        dispatch_mode: 'auto_implement',
        status: 'running',
        agent_phase: 'generating',
        claude_session_id: null,
        worktree_path: worktreeContext?.worktreePath || null,
        worktree_branch: worktreeContext?.branchName || null,
        source_branch: worktreeContext?.sourceBranch || null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      let proc;
      try {
        const args = ['-p', '--output-format', 'stream-json', '--verbose',
          '--permission-mode', 'acceptEdits',
          '--dangerously-skip-permissions',
          '--add-dir', ROOT,
        ];
        if (agentDefs.length) {
          args.push('--agents', JSON.stringify(agentDefs));
        }
        proc = spawn(CLAUDE_BIN, args, {
          cwd: effectiveCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT },
        });
      } catch (spawnErr) {
        return json(res, { error: `Failed to spawn claude: ${spawnErr.message}` }, 500);
      }

      if (!proc.stdin.write(prompt)) {
        await new Promise(r => proc.stdin.once('drain', r));
      }
      proc.stdin.end();

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      dispatches.set(id, dispatch);
      saveDispatchToDb(dispatch);
      json(res, { dispatch_id: id, status: 'running' });
    }],

    // Stream dispatch output (SSE)
    // Return raw JSONL log content as plain text (reliable, no SSE race)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/log$/, 'GET', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');
      // Serve from memory — disk is only for restart recovery
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(dispatch.output.join('\n'));
    }],

    // SSE stream — supports ?after=N to skip first N lines (used after HTTP log fetch)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/stream$/, 'GET', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');

      const afterLine = parseInt(new URL(_req.url, 'http://x').searchParams.get('after') || '0');

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      });

      // Replay from memory — disk is only for restart recovery
      let replayCount = 0;
      for (const line of dispatch.output) {
        replayCount++;
        if (replayCount > afterLine) res.write(`data: ${line}\n\n`);
      }

      if (dispatch.status !== 'running') {
        res.write(`event: done\ndata: ${JSON.stringify({ status: dispatch.status, replay_lines: replayCount })}\n\n`);
        res.end();
        return;
      }

      // Listen for new events
      // SSE adapter: wrap the HTTP response as a fake wsClient for unified broadcasting
      const sseAdapter = {
        send(raw) {
          try {
            const msg = JSON.parse(raw);
            if (msg.type === 'data') {
              res.write(`data: ${msg.data}\n\n`);
            } else if (msg.type === 'done') {
              res.write(`event: done\ndata: ${JSON.stringify({ status: msg.status })}\n\n`);
              res.end();
              dispatch.wsClients.delete(sseAdapter);
            }
          } catch {}
        },
        close() {},
        readyState: 1, // WebSocket.OPEN
      };

      dispatch.wsClients.add(sseAdapter);

      _req.on('close', () => {
        dispatch.wsClients.delete(sseAdapter);
      });
    }],

    // List dispatches (returns all including completed/failed/interrupted)
    [/^\/api\/dispatch\/active$/, 'GET', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      const list = [];
      for (const [id, d] of dispatches) {
        if (workerId !== undefined && d._testWorkerId !== workerId) continue;
        list.push({
          id,
          title: d.title || null,
          work_item_id: d.work_item_id,
          work_item_title: d.work_item_id ? db.getWorkItemTitle(d.work_item_id) : null,
          epic_id: d.epic_id || null,
          epic_title: d.epic_id ? db.getEpicTitle(d.epic_id) : null,
          project_key: d.project_key,
          project_path: d.project_path,
          status: d.status,
          cost_usd: d.cost_usd || null,
          started_at: d.started_at,
          completed_at: d.completed_at,
          last_output: d.lastLines || [],
          agent_phase: d.agent_phase || null,
          needs_input: d.agent_phase === 'waiting_for_input',
          permission_mode: d.permission_mode || 'acceptEdits',
          skip_permissions: d.skip_permissions || false,
          claude_session_id: d.claude_session_id || null,
          worktree_path: d.worktree_path || null,
          worktree_branch: d.worktree_branch || null,
          source_branch: d.source_branch || null,
          dispatch_mode: d.dispatch_mode || 'standard',
        });
      }
      json(res, list);
    }],

    // Kill all dispatches (must be before :id route)
    [/^\/api\/dispatch\/all$/, 'DELETE', async (_m, _req, res) => {
      let killed = 0;
      for (const [id, dispatch] of dispatches) {
        if (dispatch.status !== 'running') continue;
        if (dispatch.process) {
          const timer = killProcessGraceful(dispatch.process);
          dispatch.process.on('close', () => clearTimeout(timer));
        } else if (dispatch.pid && isPidAlive(dispatch.pid)) {
          try { process.kill(dispatch.pid, 'SIGTERM'); } catch {}
        }
        dispatch.status = 'killed';
        dispatch.completed_at = new Date().toISOString();
        if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
        if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
        broadcastDispatchDone(dispatch);
        archiveSession(dispatch, 'dispatch');
        saveDispatchToDb(dispatch);
        killed++;
      }
      json(res, { killed });
    }],

    // Kill a dispatch
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');
      if (dispatch.process) {
        const timer = killProcessGraceful(dispatch.process);
        dispatch.process.on('close', () => clearTimeout(timer));
      } else if (dispatch.pid && isPidAlive(dispatch.pid)) {
        try { process.kill(dispatch.pid, 'SIGTERM'); } catch {}
      }
      dispatch.status = 'killed';
      dispatch.completed_at = new Date().toISOString();
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      archiveSession(dispatch, 'dispatch');
      broadcastDispatchDone(dispatch);
      dispatches.delete(m[1]);
      db.deleteDispatch(m[1]);
      unlinkFile(join(LOGS_DIR, `${m[1]}.jsonl`)).catch(() => {});
      json(res, { status: 'killed', id: m[1] });
    }],

    // Suspend a dispatch (kill process but keep record for resume)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/suspend$/, 'POST', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');
      if (dispatch.status !== 'running') return err(res, 'dispatch is not running', 400);
      if (!dispatch.claude_session_id) return err(res, 'session ID not yet captured — try again shortly', 400);
      if (dispatch.process) {
        const timer = killProcessGraceful(dispatch.process);
        dispatch.process.on('close', () => clearTimeout(timer));
      } else if (dispatch.pid && isPidAlive(dispatch.pid)) {
        try { process.kill(dispatch.pid, 'SIGTERM'); } catch {}
      }
      dispatch.status = 'suspended';
      dispatch.completed_at = new Date().toISOString();
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      archiveSession(dispatch, 'dispatch');
      broadcastDispatchDone(dispatch);
      saveDispatchToDb(dispatch);
      json(res, { status: 'suspended', id: m[1], claude_session_id: dispatch.claude_session_id });
    }],

    // Resume a suspended dispatch
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/resume$/, 'POST', async (m, req, res) => {
      const old = dispatches.get(m[1]);
      if (!old) return err(res, 'dispatch not found');
      if (old.status !== 'suspended') return err(res, 'dispatch is not suspended', 400);
      if (!old.claude_session_id) return err(res, 'no session ID available for resume', 400);

      let body = {};
      try { body = await parseBody(req); } catch {}
      const resumeSessionId = old.claude_session_id;
      const { work_item_id, epic_id, project_key, project_path, title, permission_mode, skip_permissions, worktree_path, worktree_branch, source_branch } = old;

      // Validate worktree liveness if one was used
      const resumeCwd = worktree_path && existsSync(worktree_path) ? worktree_path : project_path;
      if (worktree_path && !existsSync(worktree_path)) {
        return err(res, `Worktree was removed (${worktree_path}). Re-dispatch to create a new one.`, 400);
      }

      // Remove old suspended record
      dispatches.delete(m[1]);
      db.deleteDispatch(m[1]);

      // Create new dispatch with --resume flag
      const id = `D-${Date.now()}`;
      const resolvedPermMode = permission_mode || 'acceptEdits';
      const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

      const dispatch = {
        id,
        work_item_id,
        epic_id,
        project_key,
        project_path,
        title: title || '',
        permission_mode: resolvedPermMode,
        skip_permissions: resolvedSkipPerms,
        status: 'running',
        agent_phase: 'generating',
        claude_session_id: resumeSessionId,
        worktree_path: worktree_path || null,
        worktree_branch: worktree_branch || null,
        source_branch: source_branch || null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      const { workItem: freshWorkItem, portfolio } = await loadResumeContext({ work_item_id, project_key });

      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      args.push('--resume', resumeSessionId);
      args.push('--permission-mode', resolvedPermMode === 'plan' ? 'plan' : 'acceptEdits');
      if (resolvedSkipPerms) args.push('--dangerously-skip-permissions');
      args.push('--add-dir', ROOT);

      const agentDefs = await selectAgentsForDispatch({ workItem: freshWorkItem, portfolio });
      if (agentDefs.length) args.push('--agents', JSON.stringify(agentDefs));

      let proc;
      try {
        proc = spawn(CLAUDE_BIN, args, { cwd: resumeCwd, env: { ...process.env, ARCHITECT_ROOT: ROOT }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return err(res, `Failed to spawn resumed dispatch: ${e.message}`, 500);
      }

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      const logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logPath = logPath;
      dispatch.logStream = createWriteStream(logPath, { flags: 'a' });
      wireDispatchHandlers(dispatch, proc);

      const prompt = buildResumePrompt({
        workItem: freshWorkItem,
        contract: null,
        additionalInstructions: body?.additional_instructions || null,
      });
      proc.stdin.write(prompt + '\n');
      proc.stdin.end();

      dispatches.set(id, dispatch);
      saveDispatchToDb(dispatch);
      json(res, { dispatch_id: id, status: 'running', resumed_from: m[1] });
    }],
  ];
}
