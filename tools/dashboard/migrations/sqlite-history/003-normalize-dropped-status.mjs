/**
 * Migration 003: Normalize non-canonical status values.
 * Fixes 67 work items in neuronic/PRO-test-app with status 'dropped' → 'cancelled'.
 * See domain/entities.md → WorkItem for valid statuses.
 */
export function up(db) {
  db.exec(`UPDATE work_items SET status = 'cancelled' WHERE status = 'dropped';`);
}
