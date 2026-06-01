export const version = 36;
export const name = '036-terminal-note';

export async function up(pool) {
  await pool.query(
    `ALTER TABLE terminals ADD COLUMN IF NOT EXISTS note VARCHAR(200) DEFAULT NULL`
  );
}

export async function down(pool) {
  await pool.query(`ALTER TABLE terminals DROP COLUMN IF EXISTS note`);
}
