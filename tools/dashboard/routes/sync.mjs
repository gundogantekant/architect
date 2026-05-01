export default function syncRoutes(deps) {
  const { json, err, db: dbModule, parseBody } = deps;

  function computeFreshness(synced_at) {
    if (!synced_at) return 'never';
    const hoursAgo = (Date.now() - new Date(synced_at).getTime()) / (1000 * 60 * 60);
    if (hoursAgo <= 6) return 'fresh';
    if (hoursAgo <= 24) return 'aging';
    return 'stale';
  }

  return [
    [/^\/api\/sync\/status$/, 'GET', async (_m, _req, res) => {
      const rows = await dbModule.getSyncStatusByProject();
      const result = rows.map(row => ({
        project_key: row.project_key,
        last_synced_at: row.last_synced_at,
        freshness: computeFreshness(row.last_synced_at),
        total_significant: row.total_significant,
      }));
      json(res, result);
    }],

    [/^\/api\/sync\/trigger$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      if (!body.project_key) return err(res, 'project_key is required', 400);
      const trigger = body.trigger || 'manual';
      const syncId = await dbModule.createKnowledgeSync(body.project_key, trigger);
      json(res, { accepted: true, sync_id: Number(syncId) });
    }],

    [/^\/api\/sync\/significant$/, 'GET', async (_m, _req, res) => {
      const rows = await dbModule.getSignificantChangeLogEntries(50);
      const result = rows.map(row => ({
        ...row,
        affected_files: row.affected_files,
      }));
      json(res, result);
    }],

    [/^\/api\/sync\/([^/]+)\/history$/, 'GET', async (m, _req, res) => {
      const projectKey = decodeURIComponent(m[1]);
      const rows = await dbModule.getKnowledgeSyncHistory(projectKey, 20);
      json(res, rows);
    }],

    [/^\/api\/sync\/(\d+)$/, 'PATCH', async (m, req, res) => {
      const id = Number(m[1]);
      const body = await parseBody(req);
      const allowed = ['status', 'synced_at', 'commit_from', 'commit_to', 'commits_scanned', 'significant_count', 'summary_json', 'error'];
      const fields = Object.fromEntries(Object.entries(body).filter(([k]) => allowed.includes(k)));
      if (!Object.keys(fields).length) return err(res, 'no valid fields to update', 400);
      await dbModule.updateKnowledgeSyncStatus(id, fields);
      json(res, { updated: id });
    }],

    [/^\/api\/sync\/entries$/, 'GET', async (_m, req, res) => {
      const url = new URL(req.url, 'http://localhost');
      const project_key = url.searchParams.get('project_key');
      const since = url.searchParams.get('since') || null;
      if (!project_key) return err(res, 'project_key required', 400);
      const rows = await dbModule.getChangeLogEntries(project_key, since);
      json(res, rows);
    }],

    [/^\/api\/sync\/entries$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      if (!Array.isArray(body.entries) || !body.entries.length) return err(res, 'entries array required', 400);
      const inserted = await dbModule.addChangeLogEntries(body.entries);
      json(res, { inserted });
    }],

    [/^\/api\/sync\/entries\/prune$/, 'POST', async (_m, req, res) => {
      const body = await parseBody(req);
      if (!body.project_key) return err(res, 'project_key is required', 400);
      await dbModule.pruneChangeLogEntries(body.project_key);
      json(res, { pruned: true });
    }],
  ];
}
