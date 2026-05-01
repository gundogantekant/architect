/** Migration 013: Add merge tracking columns to dispatches table and merge_gate preference. */
export function up(db) {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN completion_sha TEXT;
    ALTER TABLE dispatches ADD COLUMN completion_summary TEXT;
    ALTER TABLE dispatches ADD COLUMN merge_result TEXT;
  `);
  db.prepare("INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)").run('merge_gate', 'confirm');
}
