export const id = '044-architect-default-model';
export const description = 'Seed architect default dispatch model = Opus 4.8 (1M context)';

export async function up(db) {
  await db.query(
    `INSERT INTO preferences (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    ['default_dispatch_model:ticari/architect/main', 'claude-opus-4-8[1m]']
  );
}

export async function down(db) {
  await db.query(`DELETE FROM preferences WHERE key = 'default_dispatch_model:ticari/architect/main'`);
}
