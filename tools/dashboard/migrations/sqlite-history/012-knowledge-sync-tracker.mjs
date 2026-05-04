/**
 * Migration 012: Knowledge sync tracker tables.
 *
 * Adds two tables supporting the ADR and change detection system:
 *   - knowledge_syncs: one row per sync run per project
 *   - change_log_entries: one row per significant commit detected
 *
 * Idempotent: all CREATE statements use IF NOT EXISTS.
 */

export function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_syncs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      trigger TEXT NOT NULL CHECK(trigger IN ('session_start', 'scheduled', 'manual')),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'running', 'completed', 'failed', 'skipped')),
      started_at TEXT NOT NULL,
      synced_at TEXT,
      commit_from TEXT,
      commit_to TEXT,
      commits_scanned INTEGER NOT NULL DEFAULT 0,
      significant_count INTEGER NOT NULL DEFAULT 0,
      summary_json TEXT NOT NULL DEFAULT '[]',
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_project_key ON knowledge_syncs(project_key);
    CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_synced_at ON knowledge_syncs(synced_at);
    CREATE INDEX IF NOT EXISTS idx_knowledge_syncs_project_synced ON knowledge_syncs(project_key, synced_at DESC);

    CREATE TABLE IF NOT EXISTS change_log_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      commit_hash TEXT NOT NULL,
      commit_message TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      committed_at TEXT NOT NULL,
      affected_files TEXT NOT NULL DEFAULT '[]',
      classification TEXT NOT NULL CHECK(classification IN ('architectural', 'dependency', 'feature', 'fix', 'docs', 'test', 'chore')),
      ai_summary TEXT,
      detected_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_change_log_project_key ON change_log_entries(project_key);
    CREATE INDEX IF NOT EXISTS idx_change_log_committed_at ON change_log_entries(committed_at);
    CREATE INDEX IF NOT EXISTS idx_change_log_classification ON change_log_entries(classification);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_change_log_unique ON change_log_entries(project_key, commit_hash);
  `);
}
