export default function projectsRoutes(deps) {
  const {
    db, json, err, parseBody, readFile, writeFile, unlinkFile, mkdir, join,
    PORTFOLIO, ROOT, LOGS_DIR, CLAUDE_BIN, port,
    dispatches,
    buildProjectRefinementPrompt, wireDispatchHandlers, saveDispatchToDb, broadcastDispatchDone,
    spawn, createWriteStream, existsSync,
  } = deps;

  return [
    [/^\/api\/projects$/, 'GET', async (_m, _req, res) => {
      const projects = await db.getAllProjects();
      json(res, projects.map(p => ({ org: p.org, project: p.project, component: p.component, path: p.path })));
    }],

    [/^\/api\/projects\/([^/]+)\/([^/]+)\/([^/]+)\/refine$/, 'POST', async (m, req, res) => {
      const [, org, proj, comp] = m;
      const projectKey = `${org}/${proj}/${comp}`;
      const project = await db.getProject(projectKey);
      if (!project) return err(res, 'project not found', 404);

      for (const d of (dispatches || new Map()).values()) {
        if (d.project_key === projectKey && d.dispatch_mode === 'project_refinement' && d.status === 'running') {
          const pidAlive = d.pid ? (() => { try { process.kill(d.pid, 0); return true; } catch { return false; } })() : false;
          if (pidAlive) return err(res, 'project refinement already in progress', 409);
        }
      }

      const body = await parseBody(req);
      const templatePath = join(PORTFOLIO, org, proj, `${comp}-refinement-template.md`);
      const defaultTemplatePath = join(ROOT, 'templates', 'refinement-template.md');

      let template;
      try {
        template = await readFile(templatePath, 'utf8');
      } catch {
        template = await readFile(defaultTemplatePath, 'utf8');
        await mkdir(join(PORTFOLIO, org, proj), { recursive: true });
        await writeFile(templatePath, template);
      }

      const backlog = await db.getBacklog(org, false);
      const projectGroup = (backlog.projects || {})[projectKey] || { items: [] };
      const nonTerminalStatuses = new Set(['draft', 'planned', 'blocked']);
      const items = (projectGroup.items || [])
        .filter(it => nonTerminalStatuses.has(it.status))
        .sort((a, b) => {
          const pOrder = { high: 0, medium: 1, low: 2, critical: 0 };
          const pa = pOrder[a.priority] ?? 1;
          const pb = pOrder[b.priority] ?? 1;
          if (pa !== pb) return pa - pb;
          return a.id.localeCompare(b.id);
        });

      const allEpics = (backlog.epics || []);
      const epics = allEpics.filter(e => (e.project_keys || []).includes(projectKey));

      const prompt = buildProjectRefinementPrompt({
        projectKey,
        projectPath: project.path,
        template,
        items,
        epics,
        instructions: body.instructions || '',
        dryRun: body.dry_run || false,
        port,
      });

      const dispatchId = `D-${Date.now()}`;
      const dispatch = {
        id: dispatchId,
        work_item_id: null,
        epic_id: null,
        project_key: projectKey,
        project_path: project.path || ROOT,
        title: `Refine Project: ${projectKey}`,
        permission_mode: 'plan',
        skip_permissions: false,
        dispatch_mode: 'project_refinement',
        status: 'running',
        agent_phase: 'generating',
        agent_phase_history: [],
        claude_session_id: null,
        worktree_path: null,
        worktree_branch: null,
        source_branch: null,
        output: [],
        lastLines: [],
        wsClients: new Set(),
        started_at: new Date().toISOString(),
        completed_at: null,
      };

      // Use project path if it exists; fall back to ROOT to prevent spawn ENOENT crashes
      const effectiveCwd = (project.path && existsSync(project.path)) ? project.path : ROOT;

      let proc;
      try {
        proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'plan'], {
          cwd: effectiveCwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
        });
      } catch (spawnErr) {
        return err(res, `Failed to spawn claude: ${spawnErr.message}`, 500);
      }

      // Guard against unhandled spawn errors (e.g. ENOENT for bad cwd) before wireDispatchHandlers is called.
      // The error event fires asynchronously, so we must attach it before any await.
      let spawnError = null;
      let drainResolve = null;
      const resolveOnce = (e) => { if (drainResolve) { const r = drainResolve; drainResolve = null; r(); } if (e) spawnError = e; };
      proc.once('error', (e) => resolveOnce(e));
      proc.stdin.once('error', () => resolveOnce(null));

      if (!proc.stdin.write(prompt)) {
        await new Promise(r => { drainResolve = r; proc.stdin.once('drain', () => resolveOnce(null)); });
      }

      if (spawnError) {
        try { proc.kill(); } catch {}
        return err(res, `Failed to spawn claude: ${spawnError.message}`, 500);
      }

      proc.stdin.end();

      dispatch.process = proc;
      dispatch.pid = proc.pid;
      dispatch.logPath = join(LOGS_DIR, `${dispatchId}.jsonl`);
      dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

      wireDispatchHandlers(dispatch, proc);

      dispatches.set(dispatchId, dispatch);
      await saveDispatchToDb(dispatch);
      json(res, { dispatch_id: dispatchId, accepted: true });
    }],

    [/^\/api\/projects\/([^/]+)\/([^/]+)\/([^/]+)\/artifacts\/refinement-template$/, 'GET', async (m, _req, res) => {
      const [, org, proj, comp] = m;
      const templatePath = join(PORTFOLIO, org, proj, `${comp}-refinement-template.md`);
      const defaultTemplatePath = join(ROOT, 'templates', 'refinement-template.md');

      try {
        const content = await readFile(templatePath, 'utf8');
        return json(res, { body: content, source: 'custom' });
      } catch {
        let content;
        try {
          content = await readFile(defaultTemplatePath, 'utf8');
        } catch {
          return err(res, 'refinement template not found', 404);
        }
        await mkdir(join(PORTFOLIO, org, proj), { recursive: true });
        await writeFile(templatePath, content);
        return json(res, { body: content, source: 'default' });
      }
    }],

    [/^\/api\/projects\/([^/]+)\/([^/]+)\/([^/]+)\/artifacts\/refinement-template$/, 'PUT', async (m, req, res) => {
      const [, org, proj, comp] = m;
      const body = await parseBody(req);
      if (typeof body.body !== 'string') return err(res, 'body must be a string', 400);
      await mkdir(join(PORTFOLIO, org, proj), { recursive: true });
      await writeFile(join(PORTFOLIO, org, proj, `${comp}-refinement-template.md`), body.body);
      json(res, { saved: true });
    }],

    [/^\/api\/projects\/([^/]+)\/([^/]+)\/([^/]+)\/artifacts\/refinement-template$/, 'DELETE', async (m, _req, res) => {
      const [, org, proj, comp] = m;
      try {
        await unlinkFile(join(PORTFOLIO, org, proj, `${comp}-refinement-template.md`));
      } catch {}
      json(res, { deleted: true });
    }],
  ];
}
