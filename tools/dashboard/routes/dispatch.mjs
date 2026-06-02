import { existsSync, createReadStream } from 'node:fs';
import { createWorktreeForDispatch, shouldCreateWorktree, isGitRepository, checkWorktreeReadiness } from '../worktree.mjs';
import { AUTO_IMPLEMENTABLE_STATUSES, DISPATCH_TIMEOUT_MS, EXTEND_DURATION_MS, HEARTBEAT_INTERVAL_MS, INPUT_NEEDED_SOURCE, PIPELINE_STAGES, PORTFOLIO } from '../constants.mjs';
import { triggerMerge, scheduleDispatchTimeout, appendProgress } from '../dispatch-manager.mjs';
import { isMediumOrAbove } from '../utils/complexity.mjs';
import { validateContract } from '../utils/contract-validation.mjs';
import { writePromptFile, deletePromptFile } from '../prompt-file.mjs';
import { deriveContractFromDescription } from '../prompt-builder.mjs';

const SKILL_REGISTRY = {
  'project-refine-tasks': (workItemId) => workItemId ? `/project-refine-tasks ${workItemId}` : '/project-refine-tasks',
};

function complexityTierFromPriority(priority) {
  if (priority === 'critical' || priority === 'high') return 'large';
  if (priority === 'medium') return 'medium';
  return 'small';
}



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
async function resolveUnmetDependencies(db, dependsOn) {
  if (!dependsOn || !dependsOn.length) return [];
  const results = await Promise.all(dependsOn.map(async depId => {
    const dep = await db.getWorkItemFull(depId);
    return (!dep || dep.status !== 'done') ? depId : null;
  }));
  return results.filter(Boolean);
}

export default function dispatchRoutes(deps) {
  const {
    db, json, err, parseBody,
    ROOT, LOGS_DIR, CLAUDE_BIN,
    dispatches,
    wireDispatchHandlers,
    buildDispatchPrompt, buildResumePrompt, buildAutoImplementPrompt, buildTaskCreationPrompt, resolveProjectPath, loadPortfolioContext, loadWorkItem, loadResumeContext, selectAgentsForDispatch, loadEpicPlanSnippet,
    broadcastDispatchLine, broadcastDispatchDone, killProcessGraceful,
    saveDispatchToDb, archiveSession,
    isPidAlive,
    spawn, createWriteStream, unlinkFile, join,
    TMP_DIR,
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
        agent_phase_history: [],
        contract: null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      // Prompt delivery: write to a per-session file under tmp/ (when small enough), then stream
      // the file to the child's stdin. Streaming with backpressure addresses the buffer-truncation
      // risk that motivated W-1141, while keeping the prompt as the user message that `-p` mode
      // requires (--append-system-prompt-file only appends to the system prompt and leaves -p
      // without input — regression seen in W-1184).
      const onboardPromptFile = await writePromptFile(prompt, id, TMP_DIR);

      const MAX_PROMPT_CHARS = 1_048_576; // 1MB
      const onboardTruncated = prompt.length > MAX_PROMPT_CHARS;
      const onboardCapturedText = onboardTruncated ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;

      let proc;
      try {
        const onboardArgs = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'];
        proc = spawn(CLAUDE_BIN, onboardArgs, {
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
        });
      } catch (spawnErr) {
        await deletePromptFile(onboardPromptFile).catch(() => {});
        return json(res, { error: `Failed to spawn claude: ${spawnErr.message}` }, 500);
      }

      if (onboardPromptFile) {
        const stream = createReadStream(onboardPromptFile);
        stream.on('error', e => console.error('[prompt-stream onboard]', e.message));
        stream.pipe(proc.stdin);
      } else {
        if (!proc.stdin.write(prompt)) {
          await new Promise(r => proc.stdin.once('drain', r));
        }
        proc.stdin.end();
      }

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.prompt_file = onboardPromptFile || null;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      // Capture prompt for audit — must run after saveDispatchToDb so the FK parent row exists
      await db.insertPromptRecord({
        dispatch_id: id,
        work_item_id: null,
        project_key: null,
        prompt_text: onboardCapturedText,
        char_count: onboardCapturedText.length,
        truncated: onboardTruncated,
      }).catch(e => console.error('[prompt-capture] failed:', e.message));
      json(res, { dispatch_id: id, status: 'running' });
    }],

    // --- Dispatch endpoints ---

    // Create dispatch
    [/^\/api\/dispatch$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions, permission_mode, contract: rawContract, dispatch_mode: rawDispatchMode, skill_id } = body;
      const dispatch_mode = rawDispatchMode || 'standard';

      // Strip empty-string contract fields per domain/rules.md → Dispatch Contract Rules
      let contract = null;
      if (rawContract && typeof rawContract === 'object') {
        const cleaned = {};
        const ARRAY_FIELDS = new Set(['stop_conditions', 'e2e_test_criteria']);
        for (const [k, v] of Object.entries(rawContract)) {
          if (ARRAY_FIELDS.has(k)) {
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
      if (skill_id !== undefined && !SKILL_REGISTRY[skill_id]) {
        return err(res, `Unknown skill_id: ${skill_id}`, 400);
      }
      if (!work_item_id && !additional_instructions && dispatch_mode !== 'task_creation' && !skill_id) {
        return err(res, 'work_item_id or additional_instructions is required', 400);
      }

      const resolvedPath = await resolveProjectPath(project_key);
      if (!resolvedPath && dispatch_mode !== 'task_creation') {
        return err(res, `Could not resolve path for project: ${project_key}`, 400);
      }
      const projectPath = resolvedPath;

      const id = `D-${Date.now()}`;

      const [portfolio, workItem] = await Promise.all([
        loadPortfolioContext(project_key),
        work_item_id ? loadWorkItem(work_item_id) : null,
      ]);

      let epicContext = null;
      if (epic_id) {
        try {
          const epicFull = await db.getEpicFull(epic_id);
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

      const effectiveWorkItem = workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'draft', priority: 'medium', tags: [], session_log: [] } : null);

      // Validate contract completeness for medium+ complexity before proceeding.
      // Runs on rawContract (pre-strip) so empty-string fields are caught as missing.
      // Skill dispatches bypass contract validation — the skill manages its own workflow.
      if (!skill_id) {
        const contractViolations = validateContract(effectiveWorkItem, rawContract);
        if (contractViolations) {
          return json(res, { error: 'Contract incomplete', violations: contractViolations }, 422);
        }
      }

      // Resolve permission mode and skip_permissions independently
      const resolvedPermMode = permission_mode || 'acceptEdits';
      const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

      // --- Dispatch-level worktree creation (W-927) ---
      const featureFlag = ((await db.getPreference('worktree_at_dispatch')) ?? 'true') === 'true';
      const rawEntry = portfolio?.entry || null;
      let worktreeContext = null;
      let effectiveCwd = projectPath;

      // Skill dispatches run at project root — no worktree isolation needed.
      const willCreateWorktree = !skill_id && await shouldCreateWorktree({
        permissionMode: resolvedPermMode,
        workItemId: work_item_id,
        portfolioEntry: rawEntry,
        featureFlag,
        projectPath,
      });
      const readinessWarning = willCreateWorktree && !body.confirm_worktree_warning
        ? checkWorktreeReadiness({ portfolioEntry: rawEntry, projectKey: project_key })
        : null;
      if (readinessWarning) {
        return json(res, readinessWarning);
      }

      // Validate derived contract completeness before worktree creation
      if (!skill_id && (!rawContract || Object.keys(rawContract).length === 0)) {
        if (isMediumOrAbove(effectiveWorkItem)) {
          const derived = deriveContractFromDescription(effectiveWorkItem?.description ?? '');
          if (derived) {
            const derivedViolations = validateContract(effectiveWorkItem, derived);
            if (derivedViolations) {
              return json(res, {
                error: 'Contract derived from description is incomplete for medium+ complexity',
                violations: derivedViolations,
                hint: 'Add structured **Goal**, **Constraints**, **Expected Output**, **Failure Conditions**, and **E2E Test Criteria** sections to the work item description, or supply an explicit contract.',
              }, 422);
            }
          } else {
            const coreViolations = ['goal', 'constraints', 'expected_output', 'failure_conditions'].map(f => ({
              field: f, message: `required for medium+ complexity`,
            }));
            coreViolations.push({ field: 'e2e_test_criteria', message: 'required for medium+ complexity' });
            return json(res, {
              error: 'No contract provided and no structured contract sections found in description',
              violations: coreViolations,
              hint: 'Provide an explicit contract or add **Goal**, **Constraints**, **Expected Output**, **Failure Conditions**, **E2E Test Criteria** sections to the description.',
            }, 422);
          }
        }
      }

      // Warn when worktree isolation is bypassed for medium+ complexity
      const portfolioMode = rawEntry?.worktree_mode;
      if (portfolioMode === 'explicit' && isMediumOrAbove(effectiveWorkItem)) {
        if (!body.worktree_explicit_acknowledged) {
          return json(res, {
            warning: `Work item ${work_item_id} has medium+ complexity but project '${project_key}' has worktree_mode: "explicit" — isolation is bypassed. The domain Isolated Work Mandate requires worktree isolation for medium+ work. Pass worktree_explicit_acknowledged: true to proceed anyway.`,
            require_confirm: true,
          });
        }
      }

      if (willCreateWorktree) {
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

      const prompt = skill_id
        ? SKILL_REGISTRY[skill_id](work_item_id || '')
        : (dispatch_mode === 'task_creation'
          ? buildTaskCreationPrompt(project_key, additional_instructions || '')
          : buildDispatchPrompt({
              workItem: effectiveWorkItem,
              projectKey: project_key,
              projectPath,
              additionalInstructions: additional_instructions,
              portfolio,
              epicContext,
              relatedProjects,
              worktreeContext,
              contract: contract && Object.keys(contract).length ? contract : null,
            }));

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
        dispatch_mode: skill_id ? 'skill' : dispatch_mode,
        skill_id: skill_id || null,
        status: 'running',
        agent_phase: 'generating',
        agent_phase_history: [],
        contract: contract || null,
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

      // Prompt delivery: see W-1184 comment in the onboard handler above.
      const standardPromptFile = await writePromptFile(prompt, id, TMP_DIR);

      const MAX_PROMPT_CHARS = 1_048_576; // 1MB
      const standardTruncated = prompt.length > MAX_PROMPT_CHARS;
      const standardCapturedText = standardTruncated ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;

      let proc;
      try {
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'];
        args.push('--permission-mode', resolvedPermMode === 'plan' ? 'plan' : 'acceptEdits');
        if (resolvedSkipPerms) {
          args.push('--dangerously-skip-permissions');
        }
        args.push('--add-dir', ROOT);
        if (agentDefs.length) {
          args.push('--agents', JSON.stringify(agentDefs));
        }
        proc = spawn(CLAUDE_BIN, args, {
          cwd: effectiveCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
        });
      } catch (spawnErr) {
        await deletePromptFile(standardPromptFile).catch(() => {});
        return json(res, { error: `Failed to spawn claude: ${spawnErr.message}` }, 500);
      }

      if (standardPromptFile) {
        const stream = createReadStream(standardPromptFile);
        stream.on('error', e => console.error('[prompt-stream standard]', e.message));
        stream.pipe(proc.stdin);
      } else {
        if (!proc.stdin.write(prompt)) {
          await new Promise(r => proc.stdin.once('drain', r));
        }
        proc.stdin.end();
      }

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.prompt_file = standardPromptFile || null;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      const tier = complexityTierFromPriority(effectiveWorkItem?.priority);
      scheduleDispatchTimeout(dispatch, DISPATCH_TIMEOUT_MS[tier] ?? DISPATCH_TIMEOUT_MS.medium, saveDispatchToDb);

      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      // Capture prompt for audit — must run after saveDispatchToDb so the FK parent row exists
      await db.insertPromptRecord({
        dispatch_id: id,
        work_item_id: work_item_id || null,
        project_key: project_key || null,
        prompt_text: standardCapturedText,
        char_count: standardCapturedText.length,
        truncated: standardTruncated,
      }).catch(e => console.error('[prompt-capture] failed:', e.message));
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

      if (!AUTO_IMPLEMENTABLE_STATUSES.includes(workItem.status)) {
        return err(res, `Work item status '${workItem.status}' cannot be auto-implemented. Must be ${AUTO_IMPLEMENTABLE_STATUSES.join(', ')}.`, 400);
      }

      const unmetDeps = await resolveUnmetDependencies(db, workItem.depends_on || []);
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

      const featureFlag = ((await db.getPreference('worktree_at_dispatch')) ?? 'true') === 'true';
      const portfolio = await loadPortfolioContext(project_key);
      const rawEntry = portfolio?.entry || null;
      let worktreeContext = null;

      const willCreateWorktree = await shouldCreateWorktree({
        permissionMode: 'acceptEdits',  // auto-implement always runs in acceptEdits mode
        workItemId: work_item_id,
        portfolioEntry: rawEntry,
        featureFlag,
        projectPath,
      });

      if (willCreateWorktree) {
        try {
          worktreeContext = await createWorktreeForDispatch({
            projectPath,
            portfolioEntry: rawEntry,
            workItemId: work_item_id,
            workItemTitle: workItem.title || work_item_id,
            orgConventions: portfolio?.org,
          });
        } catch (worktreeErr) {
          return err(res, `Failed to create worktree: ${worktreeErr.message}`, 500);
        }
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
        agent_phase_history: [],
        contract: null,
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

      // Prompt delivery: see W-1184 comment in the onboard handler above.
      const autoPromptFile = await writePromptFile(prompt, id, TMP_DIR);

      const MAX_PROMPT_CHARS = 1_048_576; // 1MB
      const autoTruncated = prompt.length > MAX_PROMPT_CHARS;
      const autoCapturedText = autoTruncated ? prompt.slice(0, MAX_PROMPT_CHARS) : prompt;

      let proc;
      try {
        const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
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
          env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
        });
      } catch (spawnErr) {
        await deletePromptFile(autoPromptFile).catch(() => {});
        return json(res, { error: `Failed to spawn claude: ${spawnErr.message}` }, 500);
      }

      if (autoPromptFile) {
        const stream = createReadStream(autoPromptFile);
        stream.on('error', e => console.error('[prompt-stream auto]', e.message));
        stream.pipe(proc.stdin);
      } else {
        if (!proc.stdin.write(prompt)) {
          await new Promise(r => proc.stdin.once('drain', r));
        }
        proc.stdin.end();
      }

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.prompt_file = autoPromptFile || null;
      dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      const autoTier = complexityTierFromPriority(effectiveWorkItem?.priority);
      scheduleDispatchTimeout(dispatch, DISPATCH_TIMEOUT_MS[autoTier] ?? DISPATCH_TIMEOUT_MS.medium, saveDispatchToDb);

      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      // Capture prompt for audit — must run after saveDispatchToDb so the FK parent row exists
      await db.insertPromptRecord({
        dispatch_id: id,
        work_item_id: work_item_id || null,
        project_key: project_key || null,
        prompt_text: autoCapturedText,
        char_count: autoCapturedText.length,
        truncated: autoTruncated,
      }).catch(e => console.error('[prompt-capture] failed:', e.message));
      json(res, { id, dispatch_id: id, status: 'running', worktree_path: dispatch.worktree_path });
    }],

    // Return raw JSONL log content as plain text; ?after=N skips first N lines (O(new_lines) tailing)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/log$/, 'GET', async (m, req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');
      const after = Math.max(0, parseInt(new URL(req.url, 'http://x').searchParams.get('after') ?? '0', 10) || 0);
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(dispatch.output.slice(after).join('\n'));
    }],

    // Agents emit progress milestones; appended to JSONL and broadcast to active SSE clients
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/progress$/, 'POST', async (m, req, res) => {
      const sessionDepth = parseInt(req.headers['x-architect-session-depth'] ?? '0', 10);
      if (sessionDepth < 1) {
        return json(res, { error: 'progress endpoint is agent-only (requires X-Architect-Session-Depth >= 1)' }, 403);
      }
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      const body = await parseBody(req);
      const { phase, message } = body ?? {};
      if (!phase || typeof phase !== 'string') return err(res, 'phase required', 400);
      if (!message || typeof message !== 'string') return err(res, 'message required', 400);
      if (message.length > 200) return err(res, 'message exceeds 200 chars', 400);
      if (phase === 'e2e_verified') {
        await db.setContractSatisfied(dispatch.id);
        dispatch.contract_satisfied = true;
      }
      const event = { type: 'progress', phase, message, ts: new Date().toISOString() };
      appendProgress(dispatch, event);
      res.writeHead(204); res.end();
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
              clearInterval(heartbeatId);
            }
          } catch {}
        },
        close() {},
        readyState: 1, // WebSocket.OPEN
      };

      dispatch.wsClients.add(sseAdapter);

      const heartbeatId = setInterval(() => {
        if (!res.writableEnded) res.write(': keep-alive\n\n');
      }, HEARTBEAT_INTERVAL_MS);

      _req.on('close', () => {
        dispatch.wsClients.delete(sseAdapter);
        clearInterval(heartbeatId);
      });
    }],

    // List dispatches (returns all including completed/failed/interrupted)
    [/^\/api\/dispatch\/active$/, 'GET', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      const reqUrl = new URL(req.url, 'http://x');
      const includeDeleted = reqUrl.searchParams.get('include_deleted') === 'true';
      const projectKey = reqUrl.searchParams.get('project_key') || null;
      const list = await Promise.all([...dispatches].map(async ([id, d]) => {
        if (workerId !== undefined && d._testWorkerId !== workerId) return null;
        return {
          id,
          title: d.title || null,
          work_item_id: d.work_item_id,
          work_item_title: d.work_item_id ? await db.getWorkItemTitle(d.work_item_id) : null,
          epic_id: d.epic_id || null,
          epic_title: d.epic_id ? await db.getEpicTitle(d.epic_id) : null,
          project_key: d.project_key,
          project_path: d.project_path,
          status: d.status,
          cost_usd: d.cost_usd || null,
          started_at: d.started_at,
          completed_at: d.completed_at,
          last_output: d.lastLines || [],
          agent_phase: d.agent_phase || null,
          agent_phase_history: d.agent_phase_history || [],
          needs_input: d.agent_phase === 'waiting_for_input',
          work_item_input_needed: d.work_item_id ? await db.getWorkItemInputNeeded(d.work_item_id).catch(() => false) : false,
          permission_mode: d.permission_mode || 'acceptEdits',
          skip_permissions: d.skip_permissions || false,
          claude_session_id: d.claude_session_id || null,
          worktree_path: d.worktree_path || null,
          worktree_branch: d.worktree_branch || null,
          source_branch: d.source_branch || null,
          dispatch_mode: d.dispatch_mode || 'standard',
          skill_id: d.skill_id || null,
          completion_sha: d.completion_sha || null,
          completion_summary: d.completion_summary || null,
          completion_summary_error: d.completion_summary_error || null,
          merge_result: d.merge_result || null,
          pipeline_stage: d.pipeline_stage || null,
          contract: d.contract || null,
          _exitedWithoutSignal: d._exitedWithoutSignal || false,
          session_log: Array.isArray(d.session_log) ? d.session_log : [],
          timeout_at: d.timeout_at || null,
          last_output_at: d.lastOutputAt ? new Date(d.lastOutputAt).toISOString() : null,
          exit_type: d.exit_type || null,
          contract_satisfied: d.contract_satisfied ?? null,
          scope_violation: d.scope_violation ?? false,
          deleted_at: null,
        };
      }));
      const active = list.filter(Boolean).filter(d => !projectKey || d.project_key === projectKey);
      if (!includeDeleted) {
        json(res, active);
        return;
      }
      const deleted = await db.getDeletedDispatches();
      const deletedRows = deleted
        .filter(d => !projectKey || d.project_key === projectKey)
        .map(d => ({
          id: d.id,
          title: d.title || null,
          work_item_id: d.work_item_id || null,
          work_item_title: null,
          epic_id: d.epic_id || null,
          epic_title: null,
          project_key: d.project_key,
          project_path: d.project_path || null,
          status: d.status,
          cost_usd: d.cost_usd || null,
          started_at: d.started_at,
          completed_at: d.completed_at || null,
          last_output: [],
          agent_phase: null,
          agent_phase_history: [],
          needs_input: false,
          work_item_input_needed: false,
          permission_mode: d.permission_mode || 'acceptEdits',
          skip_permissions: d.skip_permissions || false,
          claude_session_id: d.claude_session_id || null,
          worktree_path: d.worktree_path || null,
          worktree_branch: d.worktree_branch || null,
          source_branch: d.source_branch || null,
          dispatch_mode: d.dispatch_mode || 'standard',
          completion_sha: d.completion_sha || null,
          completion_summary: d.completion_summary || null,
          completion_summary_error: d.completion_summary_error || null,
          merge_result: d.merge_result || null,
          pipeline_stage: d.pipeline_stage || null,
          contract: d.contract || null,
          _exitedWithoutSignal: false,
          session_log: [],
          timeout_at: d.timeout_at || null,
          deleted_at: d.deleted_at,
        }));
      json(res, [...active, ...deletedRows]);
    }],

    // List autonomous (auto-implement) dispatches only
    [/^\/api\/dispatch\/autonomous$/, 'GET', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      const list = await Promise.all([...dispatches].map(async ([id, d]) => {
        if (workerId !== undefined && d._testWorkerId !== workerId) return null;
        if (d.dispatch_mode !== 'auto_implement') return null;
        return {
          id,
          title: d.title || null,
          work_item_id: d.work_item_id,
          work_item_title: d.work_item_id ? await db.getWorkItemTitle(d.work_item_id) : null,
          epic_id: d.epic_id || null,
          epic_title: d.epic_id ? await db.getEpicTitle(d.epic_id) : null,
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
          dispatch_mode: 'auto_implement',
          completion_sha: d.completion_sha || null,
          completion_summary: d.completion_summary || null,
          merge_result: d.merge_result || null,
          pipeline_stage: d.pipeline_stage || null,
        };
      }));
      json(res, list.filter(Boolean));
    }],

    // Update pipeline stage for an autonomous dispatch (agent-only: depth >= 1)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/stage$/, 'PUT', async (m, req, res) => {
      const depth = parseInt(req.headers['x-architect-session-depth'] ?? '0', 10);
      if (depth < 1) return err(res, 'pipeline stage updates are agent-only (depth >= 1)', 403);
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      const body = await parseBody(req);
      const { stage } = body;
      if (!stage || !PIPELINE_STAGES.includes(stage)) {
        return err(res, `invalid stage: must be one of ${PIPELINE_STAGES.join(', ')}`, 400);
      }
      dispatch.pipeline_stage = stage;
      await db.updatePipelineStage(m[1], stage);
      json(res, { id: m[1], pipeline_stage: stage });
    }],

    // List suspended dispatches only
    [/^\/api\/dispatch\/suspended$/, 'GET', async (_m, req, res) => {
      const workerId = req.headers['x-test-worker-id'];
      const list = await Promise.all([...dispatches].map(async ([id, d]) => {
        if (workerId !== undefined && d._testWorkerId !== workerId) return null;
        if (d.status !== 'suspended') return null;
        return {
          id,
          title: d.title || null,
          work_item_id: d.work_item_id,
          work_item_title: d.work_item_id ? await db.getWorkItemTitle(d.work_item_id) : null,
          epic_id: d.epic_id || null,
          epic_title: d.epic_id ? await db.getEpicTitle(d.epic_id) : null,
          project_key: d.project_key,
          project_path: d.project_path,
          status: d.status,
          started_at: d.started_at,
          completed_at: d.completed_at,
          permission_mode: d.permission_mode || 'acceptEdits',
          skip_permissions: d.skip_permissions || false,
          claude_session_id: d.claude_session_id || null,
          worktree_path: d.worktree_path || null,
          worktree_branch: d.worktree_branch || null,
          source_branch: d.source_branch || null,
          dispatch_mode: d.dispatch_mode || 'standard',
        };
      }));
      json(res, list.filter(Boolean));
    }],

    // Kill all dispatches (must be before :id route)
    [/^\/api\/dispatch\/all$/, 'DELETE', async (_m, _req, res) => {
      let killed = 0;
      for (const [id, dispatch] of dispatches) {
        if (dispatch.status !== 'running') continue;
        // Set flag before killing so the close handler classifies exit_type correctly.
        dispatch._killedIntentionally = true;
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
        archiveSession(dispatch, 'dispatch').catch(e => console.error('[kill all] archiveSession:', e.message));
        saveDispatchToDb(dispatch).catch(e => console.error('[kill all] saveDispatchToDb:', e.message));
        killed++;
      }
      json(res, { killed });
    }],

    // Kill a dispatch
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found');
      // Set flag before killing so the close handler classifies exit_type correctly.
      dispatch._killedIntentionally = true;
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
      archiveSession(dispatch, 'dispatch').catch(e => console.error('[kill dispatch] archiveSession:', e.message));
      broadcastDispatchDone(dispatch);
      dispatches.delete(m[1]);
      const deletedAt = new Date().toISOString();
      await db.deleteDispatch(m[1]);
      json(res, { status: 'killed', id: m[1], deleted_at: deletedAt });
    }],

    // Extend the timeout of a running dispatch (UI/human-only — depth 0 required)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/extend$/, 'POST', async (m, req, res) => {
      const depth = parseInt(req.headers['x-architect-session-depth'] || '0', 10);
      if (depth !== 0) return err(res, 'POST /extend is UI/human-only (X-Architect-Session-Depth must be 0)', 403);
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      if (dispatch.status !== 'running') return err(res, 'dispatch is not running', 400);

      let body = null;
      try { body = await parseBody(req); } catch {}
      const extensionMs = (body?.duration_ms && Number.isFinite(body.duration_ms) && body.duration_ms > 0)
        ? body.duration_ms
        : EXTEND_DURATION_MS;

      // Clear existing timeout timers
      if (dispatch._timeoutHandle) { clearTimeout(dispatch._timeoutHandle); dispatch._timeoutHandle = null; }
      if (dispatch._warningHandle) { clearTimeout(dispatch._warningHandle); dispatch._warningHandle = null; }

      dispatch.timeout_at = new Date(Date.now() + extensionMs).toISOString();
      dispatch._timeoutHandle = setTimeout(() => {
        if (dispatch.status !== 'running') return;
        dispatch._timedOut = true;
        dispatch.status = 'failed';
        dispatch.completed_at = new Date().toISOString();
        if (dispatch.process) {
          try { dispatch.process.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { dispatch.process?.kill('SIGKILL'); } catch {} }, 6000);
        }
        if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
        saveDispatchToDb(dispatch).catch(e => console.error('[extend-timeout] saveDispatch:', e.message));
      }, extensionMs);

      // Clear input_needed if it was set by the timeout path
      if (dispatch.work_item_id) {
        db.setInputNeeded(dispatch.work_item_id, false, INPUT_NEEDED_SOURCE.TIMEOUT).catch(() => {});
      }

      await saveDispatchToDb(dispatch);
      json(res, { timeout_at: dispatch.timeout_at });
    }],

    // Cancel a pending merge (clears timer, keeps status as merge_pending)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/merge\/cancel$/, 'POST', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      if (dispatch.status !== 'merge_pending') return err(res, 'dispatch is not in merge_pending status', 400);
      if (dispatch._mergeTimer) {
        clearTimeout(dispatch._mergeTimer);
        dispatch._mergeTimer = null;
      }
      json(res, { status: 'merge_pending', dispatch_id: m[1], cancelled: true });
    }],

    // Trigger merge (UI/human-only — depth 0 required)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/merge$/, 'POST', async (m, req, res) => {
      const depth = parseInt(req.headers['x-architect-session-depth'] || '0', 10);
      if (depth !== 0) return err(res, 'POST /merge is UI/human-only (X-Architect-Session-Depth must be 0)', 403);
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      if (dispatch.status !== 'merge_pending') return err(res, 'dispatch is not in merge_pending status', 400);
      if (dispatch._mergeTimer) {
        clearTimeout(dispatch._mergeTimer);
        dispatch._mergeTimer = null;
      }
      triggerMerge(dispatch, deps).catch(e => console.error(`[merge] triggerMerge error for ${m[1]}:`, e));
      json(res, { status: 'merging', dispatch_id: m[1] });
    }],

    // Signal completion and request merge (agent-only — depth >= 1 required)
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/complete$/, 'POST', async (m, req, res) => {
      const depth = parseInt(req.headers['x-architect-session-depth'] || '0', 10);
      if (depth < 1) return err(res, 'POST /complete is agent-only (X-Architect-Session-Depth >= 1 required)', 403);
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      if (dispatch.status !== 'running') return err(res, `dispatch is not running (status: ${dispatch.status})`, 400);

      // Set _mergeHandled BEFORE any await — prevents close handler from overwriting status
      dispatch._mergeHandled = true;

      const body = await parseBody(req);
      const { sha, summary } = body || {};

      dispatch.status = 'merge_pending';
      dispatch.completion_sha = sha || null;
      dispatch.completion_summary = summary || null;

      await db.updateDispatchMergeResult(m[1], {
        status: 'merge_pending',
        completion_sha: sha || null,
        completion_summary: summary || null,
      });
      await saveDispatchToDb(dispatch);

      const mergeGate = (await db.getPreference('merge_gate')) ?? 'confirm';

      // Contract-satisfied auto-merge: all three conditions must hold to skip confirmation.
      // Status is already merge_pending above, so a mid-merge restart recovers via restoreSessions.
      if (dispatch.contract_satisfied && !dispatch.scope_violation && mergeGate === 'auto') {
        setImmediate(() => triggerMerge(dispatch, deps).catch(e => console.error(`[auto-merge] error for ${m[1]}:`, e)));
        return json(res, { status: 'merge_pending', message: 'Auto-merge triggered: contract satisfied and no scope violations' });
      }

      if (mergeGate === 'auto') {
        dispatch._mergeTimer = setTimeout(() => {
          triggerMerge(dispatch, deps).catch(e => console.error(`[auto-merge] error for ${m[1]}:`, e));
        }, 10000);
      }

      json(res, { status: 'merge_pending', dispatch_id: m[1] });
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
      if (dispatch._timeoutHandle) { clearTimeout(dispatch._timeoutHandle); dispatch._timeoutHandle = null; }
      if (dispatch._warningHandle) { clearTimeout(dispatch._warningHandle); dispatch._warningHandle = null; }
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      archiveSession(dispatch, 'dispatch').catch(e => console.error('[suspend dispatch] archiveSession:', e.message));
      broadcastDispatchDone(dispatch);
      await saveDispatchToDb(dispatch);
      json(res, { status: 'suspended', id: m[1], claude_session_id: dispatch.claude_session_id });
    }],

    // Dismiss an interrupted dispatch (recovery banner → user clicks "Dismiss")
    // Sets status to 'dismissed' so the recovery banner no longer appears.
    [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/dismiss$/, 'POST', async (m, _req, res) => {
      const dispatch = dispatches.get(m[1]);
      if (!dispatch) return err(res, 'dispatch not found', 404);
      if (dispatch.status !== 'interrupted') return err(res, 'only interrupted dispatches can be dismissed', 400);
      dispatch.status = 'dismissed';
      dispatch.completed_at = dispatch.completed_at || new Date().toISOString();
      await db.updateDispatchStatus(m[1], 'dismissed', dispatch.completed_at);
      json(res, { status: 'dismissed', id: m[1] });
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
      await db.deleteDispatch(m[1]);

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
        agent_phase_history: [],
        contract: null,
        claude_session_id: resumeSessionId,
        worktree_path: worktree_path || null,
        worktree_branch: worktree_branch || null,
        source_branch: source_branch || null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
        _autoExtended: old.auto_extended ?? false,
      };

      const { workItem: freshWorkItem, portfolio } = await loadResumeContext({ work_item_id, project_key });

      const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet'];
      args.push('--resume', resumeSessionId);
      args.push('--permission-mode', resolvedPermMode === 'plan' ? 'plan' : 'acceptEdits');
      if (resolvedSkipPerms) args.push('--dangerously-skip-permissions');
      args.push('--add-dir', ROOT);

      const agentDefs = await selectAgentsForDispatch({ workItem: freshWorkItem, portfolio });
      if (agentDefs.length) args.push('--agents', JSON.stringify(agentDefs));

      let proc;
      try {
        proc = spawn(CLAUDE_BIN, args, { cwd: resumeCwd, env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO }, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        return err(res, `Failed to spawn resumed dispatch: ${e.message}`, 500);
      }

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      const logPath = join(LOGS_DIR, `${id}.jsonl`);
      dispatch.logPath = logPath;
      dispatch.logStream = createWriteStream(logPath, { flags: 'a' });
      wireDispatchHandlers(dispatch, proc);

      const resumeTier = complexityTierFromPriority(freshWorkItem?.priority);
      scheduleDispatchTimeout(dispatch, DISPATCH_TIMEOUT_MS[resumeTier] ?? DISPATCH_TIMEOUT_MS.medium, saveDispatchToDb);

      const prompt = buildResumePrompt({
        workItem: freshWorkItem,
        contract: null,
        additionalInstructions: body?.additional_instructions || null,
      });
      proc.stdin.write(prompt + '\n');
      proc.stdin.end();

      dispatches.set(id, dispatch);
      await saveDispatchToDb(dispatch);
      json(res, { dispatch_id: id, status: 'running', resumed_from: m[1] });
    }],
  ];
}
