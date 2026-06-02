export const version = 40;
export const name = '040-dispatch-session-lifecycle';
export const noTransaction = false;

export async function up(pool) {
  await pool.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ NULL`);
  await pool.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS previous_dispatch_id TEXT NULL`);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_revoked_at
    ON dispatches (revoked_at) WHERE revoked_at IS NOT NULL
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_previous_dispatch_id
    ON dispatches (previous_dispatch_id) WHERE previous_dispatch_id IS NOT NULL
  `);
}

export async function down(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_dispatches_previous_dispatch_id`);
  await pool.query(`DROP INDEX IF EXISTS idx_dispatches_revoked_at`);
  await pool.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS previous_dispatch_id`);
  await pool.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS revoked_at`);
}
