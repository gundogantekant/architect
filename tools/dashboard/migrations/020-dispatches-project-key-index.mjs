export const version = 20;
export const name = '020-dispatches-project-key-index';

export async function up(pool) {
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_dispatches_project_key ON dispatches(project_key)`);
}

export async function down(pool) {
  await pool.query(`DROP INDEX IF EXISTS idx_dispatches_project_key`);
}
