export const version = 21;
export const name = '021-dispatch-timeout';

export async function up(pool) {
  await pool.query(`
    ALTER TABLE dispatches
      ADD COLUMN IF NOT EXISTS timeout_at TIMESTAMPTZ DEFAULT NULL
  `);
}

export async function down(pool) {
  await pool.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS timeout_at`);
}
