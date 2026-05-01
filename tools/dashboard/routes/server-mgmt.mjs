export default function serverMgmtRoutes(deps) {
  const {
    db, json, text, err, parseBody,
    port, ROOT, PORTFOLIO, WORK, LOG_FILE, PID_FILE, DASHCTL_PATH, SERVER_START_TIME,
    dispatches, terminals, cliSessions,
    syncProjectsFromRegistry,
    spawn, execFileSync, readFile, homedir, existsSync, join,
  } = deps;
  return [
    // --- Projects & Time Report endpoints ---

    [/^\/api\/projects$/, 'GET', async (_m, _req, res) => {
      json(res, await db.getAllProjects());
    }],

    [/^\/api\/projects\/sync$/, 'POST', async (_m, _req, res) => {
      const count = await syncProjectsFromRegistry();
      json(res, { synced: count });
    }],

    [/^\/api\/projects\/(.+)\/stats$/, 'GET', async (m, _req, res) => {
      const key = decodeURIComponent(m[1]);
      const project = await db.getProject(key);
      if (!project) return err(res, 'project not found');
      const recentSessions = await db.getSessionHistory({ project_key: key, limit: 20 });
      json(res, { ...project, recent_sessions: recentSessions });
    }],

    [/^\/api\/session-history$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const filters = {};
      for (const k of ['project_key', 'epic_id', 'work_item_id']) {
        if (url.searchParams.get(k)) filters[k] = url.searchParams.get(k);
      }
      filters.limit = parseInt(url.searchParams.get('limit') || '50', 10);
      filters.offset = parseInt(url.searchParams.get('offset') || '0', 10);
      json(res, await db.getSessionHistory(filters));
    }],

    [/^\/api\/time-report/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const group = url.searchParams.get('group');
      const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
      let today, overall, daily, monthly;
      if (group === 'org') {
        ({ today, overall } = await db.getTimeReportByOrg(todayStart.toISOString()));
        daily = await db.getTimeReportDailyByOrg(14);
        monthly = await db.getTimeReportMonthlyByOrg(6);
      } else {
        ({ today, overall } = await db.getTimeReport(todayStart.toISOString()));
        daily = await db.getTimeReportDaily(14);
        monthly = await db.getTimeReportMonthly(6);
      }
      const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
      json(res, {
        today, overall, daily, monthly,
        today_total: { sessions: sum(today, 'sessions'), time_seconds: sum(today, 'time_seconds'), cost_usd: sum(today, 'cost_usd') },
        overall_total: { sessions: sum(overall, 'sessions'), time_seconds: sum(overall, 'time_seconds'), cost_usd: sum(overall, 'cost_usd') },
      });
    }],

    // --- Server management endpoints ---

    // Server status
    [/^\/api\/server\/status$/, 'GET', async (_m, _req, res) => {
      const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
      const dispatchesActive = [...dispatches.values()].filter(d => d.status === 'running').length;
      const terminalsActive = [...terminals.values()].filter(t => t.status === 'running').length;
      json(res, {
        pid: process.pid,
        port,
        uptime_seconds: uptimeSeconds,
        node_version: process.version,
        platform: process.platform,
        sessions: {
          dispatches_active: dispatchesActive,
          terminals_active: terminalsActive,
          cli_sessions_active: [...cliSessions.values()].filter(c => c.status === 'running').length,
          dispatches_total: dispatches.size,
          terminals_total: terminals.size,
          cli_sessions_total: cliSessions.size,
        },
      });
    }],

    // Server config
    [/^\/api\/server\/config$/, 'GET', async (_m, _req, res) => {
      const home = homedir();
      const launchdPlist = join(home, 'Library', 'LaunchAgents', 'com.architect.dashboard.plist');
      const systemdUnit = join(home, '.config', 'systemd', 'user', 'architect-dashboard.service');

      let autoStart = { installed: false, type: null, service_name: null };
      if (existsSync(launchdPlist)) {
        autoStart = { installed: true, type: 'launchd', service_name: 'com.architect.dashboard' };
      } else if (existsSync(systemdUnit)) {
        autoStart = { installed: true, type: 'systemd', service_name: 'architect-dashboard' };
      }

      json(res, {
        port,
        auto_start: autoStart,
        log_file: LOG_FILE,
        pid_file: PID_FILE,
        database_file: join(WORK, 'architect.db'),
        portfolio_dir: PORTFOLIO,
      });
    }],

    // --- Preferences endpoints ---
    [/^\/api\/settings\/preferences$/, 'GET', async (_m, _req, res) => {
      json(res, await db.getAllPreferences());
    }],

    [/^\/api\/settings\/preferences$/, 'PUT', async (_m, req, res) => {
      const body = await parseBody(req);
      for (const [key, value] of Object.entries(body)) {
        await db.setPreference(key, String(value));
      }
      json(res, await db.getAllPreferences());
    }],

    // Server action (restart, stop, fresh, install, uninstall)
    [/^\/api\/server\/action$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      const { action, clear_sessions } = body;
      const validActions = ['restart', 'stop', 'fresh', 'install', 'uninstall'];
      if (!action || !validActions.includes(action)) {
        return err(res, `Invalid action. Must be one of: ${validActions.join(', ')}`, 400);
      }

      if (action === 'install' || action === 'uninstall') {
        try {
          const output = execFileSync(DASHCTL_PATH, [action], {
            encoding: 'utf8',
            timeout: 15000,
            cwd: ROOT,
          });
          json(res, { status: 'done', output: output.trim() });
        } catch (e) {
          json(res, { status: 'error', output: e.stderr || e.message }, 500);
        }
        return;
      }

      // For restart/stop/fresh — spawn detached dashctl process
      const args = [action];
      if (action === 'fresh' && clear_sessions) {
        args.push('--clear-sessions');
      }

      try {
        const child = spawn(DASHCTL_PATH, args, {
          detached: true,
          stdio: 'ignore',
          cwd: ROOT,
        });
        child.unref();
        json(res, { status: action === 'stop' ? 'stopping' : 'restarting' });
      } catch (e) {
        json(res, { status: 'error', output: e.message }, 500);
      }
    }],

    // Server logs
    [/^\/api\/server\/logs$/, 'GET', async (_m, req, res) => {
      const reqUrl = new URL(req.url, 'http://localhost');
      const lines = parseInt(reqUrl.searchParams.get('lines') || '50', 10);

      try {
        const content = await readFile(LOG_FILE, 'utf8');
        const allLines = content.split('\n');
        const tail = allLines.slice(-Math.min(lines, allLines.length)).join('\n');
        text(res, tail);
      } catch (e) {
        if (e.code === 'ENOENT') {
          text(res, '(no log file yet)');
        } else {
          text(res, `Error reading log: ${e.message}`, 'text/plain', 500);
        }
      }
    }],
  ];
}
