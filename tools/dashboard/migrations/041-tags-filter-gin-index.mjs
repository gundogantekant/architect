export const version = 41;
export const name = '041-tags-filter-gin-index';
export const noTransaction = false;

export async function up(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_work_items_tags_gin`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_items_tags_gin ON work_items USING GIN (tags)`);
}

export async function down(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_work_items_tags_gin`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_work_items_tags_gin ON work_items USING GIN (tags jsonb_path_ops)`);
}
