export const version = 28;

export async function up(pool) {
  await pool.query('ALTER TABLE terminals ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL');
}

export async function down(pool) {
  await pool.query('ALTER TABLE terminals DROP COLUMN IF EXISTS deleted_at');
}
