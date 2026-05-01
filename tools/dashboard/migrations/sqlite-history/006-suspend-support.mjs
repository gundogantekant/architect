/**
 * Migration 006: Add claude_session_id column to dispatches and terminals
 * for suspend/resume support.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN claude_session_id TEXT;
    ALTER TABLE terminals ADD COLUMN claude_session_id TEXT;
  `);
}
