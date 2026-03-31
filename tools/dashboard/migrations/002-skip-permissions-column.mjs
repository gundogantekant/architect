/**
 * Migration 002: Add skip_permissions column to dispatches and terminals tables.
 * Separates the --dangerously-skip-permissions flag from the permission_mode field.
 */
export function up(db) {
  db.exec(`
    ALTER TABLE dispatches ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE terminals ADD COLUMN skip_permissions INTEGER NOT NULL DEFAULT 0;
  `);
}
