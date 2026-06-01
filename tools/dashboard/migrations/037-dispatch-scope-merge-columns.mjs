export const id = '037-dispatch-scope-merge-columns';
export const description = 'Add scope_violation, merged_at, merge_target to dispatches';

export async function up(db) {
  await db.query(`
    ALTER TABLE dispatches
      ADD COLUMN IF NOT EXISTS scope_violation BOOLEAN NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS merged_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS merge_target TEXT
  `);
}

export async function down(db) {
  await db.query(`
    ALTER TABLE dispatches
      DROP COLUMN IF EXISTS scope_violation,
      DROP COLUMN IF EXISTS merged_at,
      DROP COLUMN IF EXISTS merge_target
  `);
}
