# Database Migrations

The dashboard's SQLite schema is managed by hand-authored migration files in `tools/dashboard/migrations/`. There is no ORM, no framework, and no build step.

## Authoring a new migration

1. **Pick the next version number.** Look at the current highest:
   ```bash
   ls tools/dashboard/migrations/ | tail -1
   ```
   Your new file uses `current + 1`, zero-padded to three digits.

2. **Create the file** with the pattern `NNN-kebab-case-description.mjs`:
   ```bash
   touch tools/dashboard/migrations/012-add-my-feature.mjs
   ```

3. **Export an `up(db, workDir)` function:**
   ```js
   export function up(db) {
     db.exec(`ALTER TABLE work_items ADD COLUMN my_new_field TEXT;`);
   }
   ```

4. **Schema assertion sync.** If your migration adds a table or a column that application code reads at startup, add it to the `expected` map in `tools/dashboard/db.mjs` (search for `KEEP IN SYNC WHEN ADDING TABLES/COLUMNS`). Otherwise the startup assertion won't catch future drift for your new schema.

5. **Restart the dashboard:**
   ```bash
   tools/dashboard/dashctl.sh restart
   ```
   The runner picks up new files on startup, applies them in version order, and records each in `schema_migrations`.

## Rules

- **Idempotency.** Write migrations so they can be re-run on a partially-migrated DB. Use `IF NOT EXISTS` for `CREATE TABLE`/`INDEX`/`TRIGGER`. Guard column adds with a `pragma table_info(...)` check. The recreate-table pattern (rename/copy/drop) should `DROP TABLE IF EXISTS <shadow>` before renaming.
- **No destructive changes without backup.** `backupDatabase()` runs before every server start. If your migration drops data, document the recovery path in the header comment.
- **Foreign keys.** New tables with FKs to existing tables must use `ON DELETE CASCADE` (or `SET NULL` for optional refs). If your migration recreates a parent table (ALTER/RENAME/CREATE), clean up orphaned child rows first — SQLite's `PRAGMA foreign_key_check` will flag them otherwise.
- **Transactions.** By default, migrations run inside a transaction. If you need `PRAGMA foreign_keys = OFF` (e.g., table recreation), export `noTransaction = true` and handle error-path pragma restoration in a `finally` block.
- **CHECK constraints on enums.** If you add a status enum, enforce it with a CHECK. Application-level validation is not sufficient — any SQL outside the route layer can bypass it.

## Guardrails

- **Duplicate-version detection** (`tools/dashboard/db.mjs`, migration runner). The runner throws at startup if two files share a version number. The W-951 incident was exactly this collision, silently skipped for three weeks.
- **Uniqueness test** (`tools/dashboard/tests/migrations.test.mjs`). `node --test` asserts unique versions at PR time, before the collision reaches a running server.
- **Skip logging** (`tools/dashboard/db.mjs`). When the runner skips a migration that's already in `schema_migrations`, it logs `Skipping migration X (version N already applied)`. Prevents silent-skip class of incident.
- **Column-level schema assertion** (`tools/dashboard/db.mjs` after the migration loop). After all migrations run, a column-level check runs against a manifest of expected tables/columns. Drift throws. Bypass with `ARCHITECT_SKIP_SCHEMA_ASSERT=1` for emergency boot.

## When something goes wrong

- **"Duplicate migration version NNN"** at startup: two files share a version number. The error message names both and suggests the next free number — rename one of them.
- **"Schema drift detected"** at startup: a migration added a column the assertion lists, but the migration didn't run or failed. Check `tmp/dashboard.log` for the last migration attempt. Restore from a backup in `assets/backups/` if recovery is needed.
- **"Foreign key violations after table recreation"** in a migration: orphaned rows in a child table. Add a `DELETE FROM <child> WHERE <fk> NOT IN (SELECT id FROM <parent>)` before the recreate step.

## Incident history

- **W-951** (April 2026): `008-org-key-column.mjs` and `008-work-item-state-machine.mjs` shared version 008. The alphabetically-first applied; the state-machine migration was silently skipped for three weeks. Dashboard API broke when code started querying `work_item_approvals` (the unmigrated table). Fix: rename to `011-work-item-state-machine.mjs`; add duplicate-version guardrail, skip logging, column-level schema assertion, and uniqueness test.
