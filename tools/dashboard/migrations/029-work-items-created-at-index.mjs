export async function up(pool) {
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_work_items_created_at ON work_items(created_at)`
  );
}
