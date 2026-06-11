export const id = '039-work-items-contract-column';
export const description = 'Add contract JSONB column to work_items for e2e_test_criteria and dispatch contract storage';

export async function up(db) {
  await db.query('ALTER TABLE work_items ADD COLUMN IF NOT EXISTS contract JSONB DEFAULT NULL');
}

export async function down(db) {
  await db.query('ALTER TABLE work_items DROP COLUMN IF EXISTS contract');
}
