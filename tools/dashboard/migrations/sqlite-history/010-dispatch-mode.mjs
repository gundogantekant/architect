/** Add dispatch_mode column to dispatches table to track auto-implement sessions. */
export function up(db) {
  db.exec(`ALTER TABLE dispatches ADD COLUMN dispatch_mode TEXT NOT NULL DEFAULT 'standard';`);
}
