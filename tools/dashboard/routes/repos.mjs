export default function reposRoutes(deps) {
  const { json, err, db: dbModule, parseBody, isPidAlive, execFileSync, spawn, existsSync, readFileSync, join, ROOT, PORTFOLIO, safe, readFile } = deps;

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

    [/^\/api\/org\/([a-zA-Z0-9_-]+)\/repos$/, 'GET', async (m, _req, res) => {
      const orgKey = m[1];
      if (!safe(orgKey)) return err(res, 'invalid org', 400);

      let orgData = {};
      try {
        const raw = await readFile(join(PORTFOLIO, orgKey, 'organization.json'), 'utf8');
        orgData = JSON.parse(raw);
      } catch {}

      const githubOrg = orgData.github_org ?? orgKey;
      const rows = await dbModule.getRepoSyncConfigsByGithubOrg(githubOrg);

      const enriched = await Promise.all(rows.map(async row => {
        if (!row.portfolio_key) return row;
        const [pOrg, pProject, pComponent] = row.portfolio_key.split('/');
        try {
          const entryRaw = await readFile(join(PORTFOLIO, pOrg, pProject, pComponent + '.json'), 'utf8');
          const entry = JSON.parse(entryRaw);
          return { ...row, portfolio: { name: entry.name, role: entry.role, last_scanned: entry.last_scanned ?? null } };
        } catch {
          return { ...row, portfolio: null };
        }
      }));

      json(res, {
        org: orgKey,
        onboarded: enriched.filter(r => r.portfolio_key),
        unregistered: enriched.filter(r => !r.portfolio_key),
        seeded: rows.length > 0,
      });
    }],

    [/^\/api\/repos\/([^/]+)\/portfolio-key$/, 'PATCH', async (m, req, res) => {
      const name = decodeURIComponent(m[1]);
      const body = await parseBody(req);
      if (!('portfolio_key' in body)) return err(res, 'portfolio_key is required', 400);
      await dbModule.setRepoPortfolioKey(name, body.portfolio_key);
      json(res, { ok: true });
    }],
  ];
}
