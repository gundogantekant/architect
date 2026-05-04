/** Migration 014: Add composite index for work item keyword search queries. */
export function up(db) {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_project_status
    ON work_items(project_key, status);
  `);
}
