export const version = 31;

export async function up(client) {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'work_items'::regclass AND conname = 'work_items_priority_check'
      ) THEN
        ALTER TABLE work_items
          ADD CONSTRAINT work_items_priority_check
          CHECK (priority IN ('low', 'medium', 'high', 'critical')) NOT VALID;
      END IF;
    END$$;
  `);

  await client.query(`ALTER TABLE work_items VALIDATE CONSTRAINT work_items_priority_check`);

  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'epics'::regclass AND conname = 'epics_priority_check'
      ) THEN
        ALTER TABLE epics
          ADD CONSTRAINT epics_priority_check
          CHECK (priority IN ('low', 'medium', 'high', 'critical')) NOT VALID;
      END IF;
    END$$;
  `);

  await client.query(`ALTER TABLE epics VALIDATE CONSTRAINT epics_priority_check`);
}

export async function down(client) {
  await client.query(`ALTER TABLE work_items DROP CONSTRAINT IF EXISTS work_items_priority_check`);
  await client.query(`ALTER TABLE epics DROP CONSTRAINT IF EXISTS epics_priority_check`);
}
