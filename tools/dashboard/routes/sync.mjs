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
      const db = dbModule.getDb();
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
      const db = dbModule.getDb();
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
      const db = dbModule.getDb();
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
      const db = dbModule.getDb();
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

    [/^\/api\/sync\/(\d+)$/, 'PATCH', async (m, req, res) => {
      const db = dbModule.getDb();
      const id = Number(m[1]);
      const body = await parseBody(req);
      const allowed = ['status', 'synced_at', 'commit_from', 'commit_to', 'commits_scanned', 'significant_count', 'summary_json', 'error'];
      const fields = Object.keys(body).filter(k => allowed.includes(k));
      if (!fields.length) return err(res, 'no valid fields to update', 400);
      const setClauses = fields.map(f => `${f} = ?`).join(', ');
      const values = fields.map(f => body[f]);
      db.prepare(`UPDATE knowledge_syncs SET ${setClauses} WHERE id = ?`).run(...values, id);
      json(res, { updated: id });
    }],

    [/^\/api\/sync\/entries$/, 'POST', async (_m, req, res) => {
      const db = dbModule.getDb();
      const body = await parseBody(req);
      if (!Array.isArray(body.entries) || !body.entries.length) return err(res, 'entries array required', 400);
      const insert = db.prepare(`
        INSERT OR IGNORE INTO change_log_entries
          (project_key, commit_hash, commit_message, author, committed_at, affected_files, classification, ai_summary, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const now = new Date().toISOString();
      let inserted = 0;
      const insertMany = db.transaction(entries => {
        for (const e of entries) {
          const r = insert.run(
            e.project_key, e.commit_hash, e.commit_message, e.author || '',
            e.committed_at, JSON.stringify(e.affected_files || []),
            e.classification, e.ai_summary || null, now,
          );
          inserted += r.changes;
        }
      });
      insertMany(body.entries);
      json(res, { inserted });
    }],

    [/^\/api\/sync\/entries\/prune$/, 'POST', async (_m, req, res) => {
      const db = dbModule.getDb();
      const body = await parseBody(req);
      if (!body.project_key) return err(res, 'project_key is required', 400);
      const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      db.prepare(`DELETE FROM change_log_entries WHERE project_key = ? AND committed_at < ?`).run(body.project_key, cutoff);
      const count = db.prepare(`SELECT COUNT(*) AS n FROM change_log_entries WHERE project_key = ?`).get(body.project_key).n;
      if (count > 100) {
        db.prepare(`
          DELETE FROM change_log_entries WHERE project_key = ? AND id NOT IN (
            SELECT id FROM change_log_entries WHERE project_key = ? ORDER BY committed_at DESC LIMIT 100
          )
        `).run(body.project_key, body.project_key);
      }
      json(res, { pruned: true });
    }],
  ];
}
