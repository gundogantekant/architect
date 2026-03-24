/**
 * Migration 005: Add projects table, session history, and aggregation views.
 * Projects are synced from portfolio registry on startup.
 * Session history is a permanent audit trail written when sessions end.
 */
export function up(db) {
  db.exec(`
    CREATE TABLE projects (
      key TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      project TEXT NOT NULL,
      component TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      total_time_seconds REAL NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      session_count INTEGER NOT NULL DEFAULT 0,
      synced_at TEXT NOT NULL
    );

    CREATE INDEX idx_projects_org ON projects(org);
    CREATE INDEX idx_projects_org_project ON projects(org, project);

    CREATE TABLE session_history (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_key TEXT NOT NULL REFERENCES projects(key),
      work_item_id TEXT,
      epic_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      permission_mode TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      cost_usd REAL
    );

    CREATE INDEX idx_session_history_project_key ON session_history(project_key);
    CREATE INDEX idx_session_history_epic_id ON session_history(epic_id);
    CREATE INDEX idx_session_history_work_item_id ON session_history(work_item_id);
    CREATE INDEX idx_session_history_ended_at ON session_history(ended_at);
    CREATE INDEX idx_session_history_project_ended ON session_history(project_key, ended_at);

    CREATE VIEW project_stats AS
    SELECT project_key,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history GROUP BY project_key;

    CREATE VIEW epic_stats AS
    SELECT epic_id,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history WHERE epic_id IS NOT NULL GROUP BY epic_id;

    CREATE VIEW work_item_stats AS
    SELECT work_item_id,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history WHERE work_item_id IS NOT NULL GROUP BY work_item_id;
  `);
}
