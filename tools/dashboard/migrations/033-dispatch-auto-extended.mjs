export const version = 33;
export const name = '033-dispatch-auto-extended';

export async function up(pool) {
  await pool.query(`
    ALTER TABLE dispatches
      ADD COLUMN IF NOT EXISTS auto_extended BOOLEAN DEFAULT FALSE
  `);
}

export async function down(pool) {
  await pool.query(`ALTER TABLE dispatches DROP COLUMN IF EXISTS auto_extended`);
}
