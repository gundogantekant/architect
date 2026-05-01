export default function reposRoutes(deps) {
  const { json, err, db: dbModule, parseBody, isPidAlive, execFileSync, spawn, existsSync, readFileSync, join, ROOT } = deps;

  return [
    [/^\/api\/repos$/, 'GET', async (_m, _req, res) => {
      const rows = await dbModule.getRepoSyncConfigs();
      json(res, rows);
    }],

    [/^\/api\/repos\/seed$/, 'POST', async (_m, _req, res) => {
      try {
        const raw = execFileSync('gh', ['api', 'orgs/NeuronicPBM/repos?per_page=100', '--paginate'], { encoding: 'utf8' });
        const repos = JSON.parse(raw);
        for (const repo of repos) {
          await dbModule.upsertRepoSyncConfig({
            github_repo_name: repo.name,
            github_org: repo.organization?.login ?? 'NeuronicPBM',
            default_branch: repo.default_branch,
            last_github_updated_at: repo.updated_at,
          });
        }
        json(res, { seeded: repos.length });
      } catch (e) {
        console.error('[repos] seed error:', e.message);
        err(res, e.message, 502);
      }
    }],

    [/^\/api\/repos\/enabled$/, 'GET', async (_m, _req, res) => {
      const rows = await dbModule.getEnabledRepos();
      json(res, rows);
    }],

    [/^\/api\/repos\/([^/]+)$/, 'PATCH', async (m, req, res) => {
      const name = decodeURIComponent(m[1]);
      const body = await parseBody(req);
      if (typeof body.sync_enabled !== 'boolean') return err(res, 'sync_enabled must be boolean', 400);
      await dbModule.setRepoSyncEnabled(name, body.sync_enabled);
      json(res, { ok: true });
    }],

    [/^\/api\/repo-sync\/run-now$/, 'POST', async (_m, _req, res) => {
      const lockFile = join(ROOT, 'tmp', 'repo-sync.lock');
      if (existsSync(lockFile)) {
        try {
          const pid = parseInt(readFileSync(lockFile, 'utf8').trim(), 10);
          if (isPidAlive(pid)) {
            return json(res, { error: 'sync already running', pid }, 409);
          }
        } catch {}
      }
      const child = spawn(
        'node',
        ['tools/repo-sync/sync-runner.mjs', '--dashboard-url', 'http://127.0.0.1:3777'],
        { stdio: 'ignore', detached: true, cwd: ROOT }
      );
      child.unref();
      json(res, { started: true });
    }],
  ];
}
