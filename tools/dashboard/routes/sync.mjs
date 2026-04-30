export default function syncRoutes(deps) {
  const { json, err, db, parseBody } = deps;

  function computeFreshness(synced_at) {
    if (!synced_at) return 'never';
    const hoursAgo = (Date.now() - new Date(synced_at).getTime()) / (1000 * 60 * 60);
    if (hoursAgo <= 6) return 'fresh';
    if (hoursAgo <= 24) return 'aging';
    return 'stale';
  }

  return [
    [/^\/api\/sync\/status$/, 'GET', async (_m, _req, res) => {
      const rows = db.prepare(`
        SELECT project_key,
          MAX(synced_at) AS last_synced_at,
          SUM(CASE WHEN status = 'completed' THEN significant_count ELSE 0 END) AS total_significant
        FROM knowledge_syncs
        WHERE status = 'completed'
        GROUP BY project_key
      `).all();
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
      const startedAt = new Date().toISOString();
      const insert = db.prepare(`
        INSERT INTO knowledge_syncs (project_key, trigger, status, started_at)
        VALUES (?, ?, 'pending', ?)
      `);
      const { lastInsertRowid } = insert.run(body.project_key, trigger, startedAt);
      json(res, { accepted: true, sync_id: Number(lastInsertRowid) });
    }],

    [/^\/api\/sync\/significant$/, 'GET', async (_m, _req, res) => {
      const rows = db.prepare(`
        SELECT id, project_key, commit_hash, commit_message, author,
               committed_at, classification, ai_summary, affected_files
        FROM change_log_entries
        WHERE classification IN ('architectural', 'dependency')
        ORDER BY committed_at DESC
        LIMIT 50
      `).all();
      const result = rows.map(row => ({
        ...row,
        affected_files: JSON.parse(row.affected_files),
      }));
      json(res, result);
    }],

    [/^\/api\/sync\/([^/]+)\/history$/, 'GET', async (m, _req, res) => {
      const projectKey = decodeURIComponent(m[1]);
      const rows = db.prepare(`
        SELECT id, project_key, trigger, status, started_at, synced_at,
               commits_scanned, significant_count, error
        FROM knowledge_syncs
        WHERE project_key = ?
        ORDER BY started_at DESC
        LIMIT 20
      `).all(projectKey);
      json(res, rows);
    }],
  ];
}
