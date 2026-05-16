// Next available after 024-dispatch-costs.mjs
// Rollback: ALTER TABLE dispatches DROP COLUMN IF EXISTS exit_type;
//   DELETE FROM schema_migrations WHERE version = 25;
//   Remove exit_type from dispatches in assertSchema in db.mjs.

export const version = 25;

export async function up(client) {
  // Add exit_type column to dispatches.
  // Values:
  //   'graceful'    — process exited with code 0
  //   'killed'      — intentionally killed via dashboard kill button or DELETE endpoint
  //   'interrupted' — ungraceful exit (crash, SIGKILL, OOM, machine shutdown)
  //   'unknown'     — exit before this migration; no exit_type classified
  // Note: dismissed and superseded are valid dispatch status values (no CHECK constraint
  // exists on dispatches.status — this is intentional for forward compatibility).
  await client.query(`
    ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS exit_type TEXT
  `);
}

export async function down(client) {
  await client.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS exit_type`);
}
