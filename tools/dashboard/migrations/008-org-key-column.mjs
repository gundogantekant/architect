/**
 * Migration 008: Add org_key column to terminals and dispatches tables
 * for organization-level dispatch support.
 */
export function up(db) {
  const termCols = db.pragma('table_info(terminals)').map(r => r.name);
  if (!termCols.includes('org_key')) {
    db.exec('ALTER TABLE terminals ADD COLUMN org_key TEXT');
  }
  const dispCols = db.pragma('table_info(dispatches)').map(r => r.name);
  if (!dispCols.includes('org_key')) {
    db.exec('ALTER TABLE dispatches ADD COLUMN org_key TEXT');
  }
}
