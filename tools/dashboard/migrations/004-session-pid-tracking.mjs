/**
 * Migration 004: Add PID tracking to dispatches and terminals for restart survival.
 * Dispatches get a pid column for liveness checks and log file replay.
 * Terminals get pid + tmux_session for PTY re-attachment.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN pid INTEGER;
    ALTER TABLE terminals ADD COLUMN pid INTEGER;
    ALTER TABLE terminals ADD COLUMN tmux_session TEXT;
  `);
}
