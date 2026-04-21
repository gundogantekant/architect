/** Add worktree tracking columns to dispatches table and feature flag preference. */
export function up(db) {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN worktree_path TEXT;
    ALTER TABLE dispatches ADD COLUMN worktree_branch TEXT;
    ALTER TABLE dispatches ADD COLUMN source_branch TEXT;
  `);
  db.prepare("INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)").run('worktree_at_dispatch', 'true');
}
