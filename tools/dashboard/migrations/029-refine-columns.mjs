export const version = 29;

export async function up(client) {
  await client.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS completion_summary_error TEXT`);
  await client.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS dry_run BOOLEAN NOT NULL DEFAULT false`);
}

export async function down(client) {
  await client.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS completion_summary_error`);
  await client.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS dry_run`);
}
