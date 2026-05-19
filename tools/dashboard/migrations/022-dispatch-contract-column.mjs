export const version = 22;
export async function up(pool) {
  await pool.query(`ALTER TABLE dispatches ADD COLUMN IF NOT EXISTS contract JSONB DEFAULT NULL`);
}
