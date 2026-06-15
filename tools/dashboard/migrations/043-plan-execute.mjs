export const id = '043-plan-execute';
export const description = 'Add chain + model columns for plan_execute dispatch mode; seed architect default and autostart preference';

export async function up(db) {
  await db.query(`
    ALTER TABLE dispatches
      ADD COLUMN IF NOT EXISTS chain_mode TEXT,
      ADD COLUMN IF NOT EXISTS chain_phase TEXT,
      ADD COLUMN IF NOT EXISTS chain_autostart BOOLEAN,
      ADD COLUMN IF NOT EXISTS chain_parent_id TEXT,
      ADD COLUMN IF NOT EXISTS model TEXT
  `);
  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_dispatches_chain_parent_id
    ON dispatches (chain_parent_id) WHERE chain_parent_id IS NOT NULL
  `);
  await db.query(
    `INSERT INTO preferences (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    ['default_dispatch_mode:ticari/architect/main', 'plan_execute']
  );
  await db.query(
    `INSERT INTO preferences (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
    ['plan_execute_autostart', 'true']
  );
}

export async function down(db) {
  await db.query(`DROP INDEX IF EXISTS idx_dispatches_chain_parent_id`);
  await db.query(`
    ALTER TABLE dispatches
      DROP COLUMN IF EXISTS chain_mode,
      DROP COLUMN IF EXISTS chain_phase,
      DROP COLUMN IF EXISTS chain_autostart,
      DROP COLUMN IF EXISTS chain_parent_id,
      DROP COLUMN IF EXISTS model
  `);
  await db.query(`DELETE FROM preferences WHERE key = 'default_dispatch_mode:ticari/architect/main'`);
  await db.query(`DELETE FROM preferences WHERE key = 'plan_execute_autostart'`);
}
