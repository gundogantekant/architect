export const id = '038-work-items-project-key-index';
export const description = 'Add index on work_items.project_key for filtered backlog and work-item reads';

export async function up(db) {
  await db.query('CREATE INDEX IF NOT EXISTS idx_work_items_project_key ON work_items(project_key)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_dispatches_project_key ON dispatches(project_key)');
  await db.query('CREATE INDEX IF NOT EXISTS idx_terminals_project_key ON terminals(project_key)');
}

export async function down(db) {
  await db.query('DROP INDEX IF EXISTS idx_work_items_project_key');
  await db.query('DROP INDEX IF EXISTS idx_dispatches_project_key');
  await db.query('DROP INDEX IF EXISTS idx_terminals_project_key');
}
