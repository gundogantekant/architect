/**
 * Migration 007: Add agent_type and head_seq columns to terminals table
 * for AgentAdapter support and EventStream sequence tracking.
 */
export function up(db) {
  const cols = db.pragma('table_info(terminals)').map(r => r.name);
  if (!cols.includes('agent_type')) {
    db.exec("ALTER TABLE terminals ADD COLUMN agent_type TEXT NOT NULL DEFAULT 'claude'");
  }
  if (!cols.includes('head_seq')) {
    db.exec('ALTER TABLE terminals ADD COLUMN head_seq INTEGER NOT NULL DEFAULT 0');
  }
}
