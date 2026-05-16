export const version = 27;

export async function up(pool) {
  await pool.query('ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL');
}

export async function down(pool) {
  await pool.query('ALTER TABLE dispatches DROP COLUMN IF EXISTS deleted_at');
}
