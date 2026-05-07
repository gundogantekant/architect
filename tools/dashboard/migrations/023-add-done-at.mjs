// Rollback: ALTER TABLE work_items DROP COLUMN done_at; delete row from schema_migrations where version=23; update assertSchema.

export const version = 23;

export async function up(pool) {
  await pool.query(`ALTER TABLE work_items ADD COLUMN IF NOT EXISTS done_at TIMESTAMPTZ`);
  // Backfill: best-effort approximation for historical rows (updated_at as proxy)
  await pool.query(`UPDATE work_items SET done_at = updated_at WHERE status = 'done' AND done_at IS NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_items_done_at ON work_items(done_at) WHERE done_at IS NOT NULL`);
}
