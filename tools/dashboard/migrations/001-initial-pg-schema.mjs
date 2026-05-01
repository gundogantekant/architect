export const version = 1;
export const name = '001-initial-pg-schema';
export const noTransaction = false;

export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS sequences (
      name TEXT PRIMARY KEY,
      next_val BIGINT NOT NULL
    )
  `);

  await client.query(`
    INSERT INTO sequences (name, next_val) VALUES ('work_item', 1), ('epic', 1)
    ON CONFLICT (name) DO NOTHING
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS work_items (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','planned','in-progress','blocked','in-review','testing','preview','done','cancelled','archived')),
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT NOT NULL DEFAULT '',
      epic_id TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      depends_on JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL,
      input_needed BOOLEAN NOT NULL DEFAULT FALSE,
      input_needed_from TEXT,
      input_needed_reason TEXT,
      input_needed_at TIMESTAMPTZ,
      approval_active BOOLEAN NOT NULL DEFAULT FALSE,
      approval_mode TEXT DEFAULT 'all' CHECK(approval_mode IN ('all','any','sequential')),
      approval_requested_at TIMESTAMPTZ,
      approval_resolved_at TIMESTAMPTZ,
      released_at TIMESTAMPTZ,
      released_version TEXT
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS work_item_logs (
      id BIGSERIAL PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      logged_at TIMESTAMPTZ NOT NULL,
      summary TEXT NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS work_item_approvals (
      id BIGSERIAL PRIMARY KEY,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      blocking_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      decided_at TIMESTAMPTZ,
      reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      target_date TEXT,
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS epic_logs (
      id BIGSERIAL PRIMARY KEY,
      epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      logged_at TIMESTAMPTZ NOT NULL,
      summary TEXT NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      work_item_id TEXT,
      epic_id TEXT,
      org_key TEXT,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      skip_permissions BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      cost_usd REAL,
      pid INTEGER,
      claude_session_id TEXT,
      worktree_path TEXT,
      worktree_branch TEXT,
      source_branch TEXT,
      dispatch_mode TEXT NOT NULL DEFAULT 'standard',
      completion_sha TEXT,
      completion_summary TEXT,
      merge_result TEXT
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS terminals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'claude',
      work_item_id TEXT,
      epic_id TEXT,
      org_key TEXT,
      project_key TEXT NOT NULL DEFAULT '',
      project_path TEXT NOT NULL DEFAULT '',
      title TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      skip_permissions BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL,
      started_at TIMESTAMPTZ NOT NULL,
      exited_at TIMESTAMPTZ,
      pid INTEGER,
      tmux_session TEXT,
      claude_session_id TEXT,
      agent_type TEXT NOT NULL DEFAULT 'claude',
      head_seq INTEGER NOT NULL DEFAULT 0
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS cli_sessions (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      work_item_id TEXT,
      epic_id TEXT,
      title TEXT NOT NULL,
      pid INTEGER NOT NULL,
      status TEXT NOT NULL,
      registered_at TIMESTAMPTZ NOT NULL,
      exited_at TIMESTAMPTZ
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS projects (
      key TEXT PRIMARY KEY,
      org TEXT NOT NULL,
      project TEXT NOT NULL,
      component TEXT NOT NULL,
      path TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      synced_at TIMESTAMPTZ NOT NULL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS session_history (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      project_key TEXT NOT NULL REFERENCES projects(key),
      work_item_id TEXT,
      epic_id TEXT,
      title TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      permission_mode TEXT,
      started_at TIMESTAMPTZ NOT NULL,
      ended_at TIMESTAMPTZ NOT NULL,
      duration_seconds REAL NOT NULL DEFAULT 0,
      cost_usd REAL
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_syncs (
      id BIGSERIAL PRIMARY KEY,
      project_key TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('session_start', 'scheduled', 'manual')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      started_at TIMESTAMPTZ NOT NULL,
      synced_at TIMESTAMPTZ,
      commit_from TEXT,
      commit_to TEXT,
      commits_scanned INTEGER NOT NULL DEFAULT 0,
      significant_count INTEGER NOT NULL DEFAULT 0,
      summary_json JSONB NOT NULL DEFAULT '[]'::jsonb,
      error TEXT
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS change_log_entries (
      id BIGSERIAL PRIMARY KEY,
      project_key TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      commit_message TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      committed_at TIMESTAMPTZ NOT NULL,
      affected_files JSONB NOT NULL DEFAULT '[]'::jsonb,
      classification TEXT NOT NULL CHECK(classification IN ('architectural', 'dependency', 'feature', 'fix', 'docs', 'test', 'chore')),
      ai_summary TEXT,
      detected_at TIMESTAMPTZ NOT NULL
    )
  `);

  // --- Indexes ---

  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_project_key ON work_items(project_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_epic_id ON work_items(epic_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_project_status ON work_items(project_key, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_tags_gin ON work_items USING GIN (tags jsonb_path_ops)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_items_depends_on_gin ON work_items USING GIN (depends_on jsonb_path_ops)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_work_item_logs_work_item_id ON work_item_logs(work_item_id)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_wia_work_item ON work_item_approvals(work_item_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_wia_identity_status ON work_item_approvals(identity, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_wia_blocking ON work_item_approvals(blocking_work_item_id) WHERE blocking_work_item_id IS NOT NULL`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_epic_logs_epic_id ON epic_logs(epic_id)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_projects_org ON projects(org)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_projects_org_project ON projects(org, project)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_session_history_project_key ON session_history(project_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_session_history_epic_id ON session_history(epic_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_session_history_work_item_id ON session_history(work_item_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_session_history_ended_at ON session_history(ended_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_session_history_project_ended ON session_history(project_key, ended_at)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_project_key ON knowledge_syncs(project_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_synced_at ON knowledge_syncs(synced_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_project_synced ON knowledge_syncs(project_key, synced_at DESC)`);

  await client.query(`CREATE INDEX IF NOT EXISTS idx_change_log_project_key ON change_log_entries(project_key)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_change_log_committed_at ON change_log_entries(committed_at)`);
  await client.query(`CREATE INDEX IF NOT EXISTS idx_change_log_classification ON change_log_entries(classification)`);
  await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_change_log_unique ON change_log_entries(project_key, commit_hash)`);

  // --- Views ---

  await client.query(`
    CREATE OR REPLACE VIEW project_stats AS
    SELECT project_key,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history GROUP BY project_key
  `);

  await client.query(`
    CREATE OR REPLACE VIEW epic_stats AS
    SELECT epic_id,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history WHERE epic_id IS NOT NULL GROUP BY epic_id
  `);

  await client.query(`
    CREATE OR REPLACE VIEW work_item_stats AS
    SELECT work_item_id,
      COUNT(*) AS session_count,
      COALESCE(SUM(duration_seconds), 0) AS total_time_seconds,
      COALESCE(SUM(cost_usd), 0) AS total_cost_usd,
      MAX(ended_at) AS last_session_at
    FROM session_history WHERE work_item_id IS NOT NULL GROUP BY work_item_id
  `);

  // --- Trigger: approval_active requires at least one pending approver ---

  await client.query(`
    CREATE OR REPLACE FUNCTION enforce_approval_active() RETURNS trigger AS $$
    BEGIN
      IF NEW.approval_active = TRUE AND NOT EXISTS (
        SELECT 1 FROM work_item_approvals WHERE work_item_id = NEW.id AND status = 'pending'
      ) THEN
        RAISE EXCEPTION 'approval_active=TRUE requires at least one pending approver';
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `);

  await client.query(`
    DROP TRIGGER IF EXISTS trg_approval_active_requires_pending ON work_items
  `);
  await client.query(`
    CREATE TRIGGER trg_approval_active_requires_pending
      BEFORE UPDATE OF approval_active ON work_items
      FOR EACH ROW WHEN (NEW.approval_active IS TRUE)
      EXECUTE FUNCTION enforce_approval_active()
  `);

  // --- Default preferences ---

  await client.query(`
    INSERT INTO preferences (key, value) VALUES
      ('default_permission_mode', 'acceptEdits'),
      ('default_skip_permissions', 'true'),
      ('worktree_at_dispatch', 'true'),
      ('merge_gate', 'confirm')
    ON CONFLICT (key) DO NOTHING
  `);

  // --- Pre-seed schema_migrations for all prior SQLite migrations ---
  // Versions 1–14 are collapsed into this single PostgreSQL DDL.

  await client.query(`
    INSERT INTO schema_migrations (version, applied_at, notes) VALUES
      (1,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (2,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (3,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (4,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (5,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (6,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (7,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (8,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (9,  NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (10, NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (11, NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (12, NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (13, NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema'),
      (14, NOW(), 'pre-seeded: collapsed into PostgreSQL initial schema')
    ON CONFLICT (version) DO NOTHING
  `);
}
