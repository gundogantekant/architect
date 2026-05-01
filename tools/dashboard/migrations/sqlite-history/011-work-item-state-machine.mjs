/**
 * Migration 011: Work item state machine redesign.
 *
 * Originally authored as 008-work-item-state-machine.mjs; renamed to 011 after a
 * version-number collision with 008-org-key-column.mjs caused the runner to silently
 * skip this migration for ~3 weeks. See docs/migrations.md for authoring guidance.
 *
 * Transforms 7-state schema into 10-state schema with orthogonal flags:
 *   - Rename: open → draft, ready → planned (historical data rewrite)
 *   - New states: in-review, testing, preview, archived
 *   - Add flag columns: input_needed (+metadata), approval_* (+normalized table), released_*
 *   - Add CHECK constraint on status enum
 *   - Recreate work_items table (rename-copy-drop) to install CHECK
 *   - Preserve FKs from work_item_logs, dispatches, terminals, cli_sessions, session_history
 *
 * Idempotent: safe to re-run on a partially migrated DB (column adds are guarded;
 * all CREATE statements use IF NOT EXISTS; work_items_old is dropped before rename).
 *
 * Opt out of the framework's auto transaction wrap — PRAGMA foreign_keys=OFF
 * is a no-op inside a transaction, and we must toggle it for the recreation step.
 */

export const noTransaction = true;

const TEN_STATES = ['draft', 'planned', 'in-progress', 'blocked', 'in-review', 'testing', 'preview', 'done', 'cancelled', 'archived'];

export function up(db) {
  db.prepare("UPDATE work_items SET status = 'draft' WHERE status = 'open'").run();
  db.prepare("UPDATE work_items SET status = 'planned' WHERE status = 'ready'").run();

  // Clean up orphaned FK rows before the recreate-step FK check.
  // work_item_logs / epic_logs have enforced FKs today; the dispatch/terminal/
  // cli_sessions/session_history cleanups are defensive against future FK additions.
  db.exec(`
    DELETE FROM work_item_logs WHERE work_item_id NOT IN (SELECT id FROM work_items);
    DELETE FROM epic_logs WHERE epic_id NOT IN (SELECT id FROM epics);
    DELETE FROM dispatches WHERE work_item_id IS NOT NULL AND work_item_id NOT IN (SELECT id FROM work_items);
    DELETE FROM terminals WHERE work_item_id IS NOT NULL AND work_item_id NOT IN (SELECT id FROM work_items);
    DELETE FROM cli_sessions WHERE work_item_id IS NOT NULL AND work_item_id NOT IN (SELECT id FROM work_items);
    DELETE FROM session_history WHERE work_item_id IS NOT NULL AND work_item_id NOT IN (SELECT id FROM work_items);
  `);

  // Idempotent column adds — columns may already exist from a partial prior run.
  const existingCols = new Set(db.pragma('table_info(work_items)').map(r => r.name));
  const newCols = [
    ['input_needed', 'INTEGER NOT NULL DEFAULT 0'],
    ['input_needed_from', 'TEXT'],
    ['input_needed_reason', 'TEXT'],
    ['input_needed_at', 'TEXT'],
    ['approval_active', 'INTEGER NOT NULL DEFAULT 0'],
    ['approval_mode', "TEXT DEFAULT 'all' CHECK(approval_mode IN ('all','any','sequential'))"],
    ['approval_requested_at', 'TEXT'],
    ['approval_resolved_at', 'TEXT'],
    ['released_at', 'TEXT'],
    ['released_version', 'TEXT'],
  ];
  for (const [name, def] of newCols) {
    if (!existingCols.has(name)) {
      db.exec(`ALTER TABLE work_items ADD COLUMN ${name} ${def};`);
    }
  }

  // If the CHECK constraint is already in place (migration previously completed),
  // skip the recreate step entirely — it's not idempotent below this point.
  const schemaRow = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'").get();
  const hasCheck = schemaRow && /CHECK\(status IN/.test(schemaRow.sql);

  if (!hasCheck) {
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');
    try {
      // Drop any stale shadow from a prior failed recreate attempt.
      db.exec(`DROP TABLE IF EXISTS work_items_old;`);

      db.exec(`
        ALTER TABLE work_items RENAME TO work_items_old;

        CREATE TABLE work_items (
          id TEXT PRIMARY KEY,
          project_key TEXT NOT NULL,
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft'
            CHECK(status IN ('draft','planned','in-progress','blocked','in-review','testing','preview','done','cancelled','archived')),
          priority TEXT NOT NULL DEFAULT 'medium',
          description TEXT NOT NULL DEFAULT '',
          epic_id TEXT,
          tags TEXT NOT NULL DEFAULT '[]',
          depends_on TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          input_needed INTEGER NOT NULL DEFAULT 0,
          input_needed_from TEXT,
          input_needed_reason TEXT,
          input_needed_at TEXT,
          approval_active INTEGER NOT NULL DEFAULT 0,
          approval_mode TEXT DEFAULT 'all' CHECK(approval_mode IN ('all','any','sequential')),
          approval_requested_at TEXT,
          approval_resolved_at TEXT,
          released_at TEXT,
          released_version TEXT
        );

        INSERT INTO work_items SELECT * FROM work_items_old;

        DROP TABLE work_items_old;
      `);

      const fkCheck = db.prepare('PRAGMA foreign_key_check').all();
      if (fkCheck.length > 0) {
        throw new Error(`Foreign key violations after table recreation: ${JSON.stringify(fkCheck)}`);
      }
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }
  }

  // Create indexes, approval table, and triggers — all guarded with IF NOT EXISTS
  // so this block is safe to run on a DB where the CHECK was already in place.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_work_items_project_key ON work_items(project_key);
    CREATE INDEX IF NOT EXISTS idx_work_items_status ON work_items(status);
    CREATE INDEX IF NOT EXISTS idx_work_items_epic_id ON work_items(epic_id);

    CREATE TABLE IF NOT EXISTS work_item_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      identity TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      sort_order INTEGER NOT NULL DEFAULT 0,
      blocking_work_item_id TEXT REFERENCES work_items(id) ON DELETE SET NULL,
      decided_at TEXT,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_wia_work_item ON work_item_approvals(work_item_id);
    CREATE INDEX IF NOT EXISTS idx_wia_identity_status ON work_item_approvals(identity, status);
    CREATE INDEX IF NOT EXISTS idx_wia_blocking ON work_item_approvals(blocking_work_item_id)
      WHERE blocking_work_item_id IS NOT NULL;

    CREATE TRIGGER IF NOT EXISTS trg_approval_active_requires_pending
    AFTER UPDATE OF approval_active ON work_items
    WHEN NEW.approval_active = 1
    BEGIN
      SELECT RAISE(ABORT, 'approval_active=1 requires at least one pending approver')
      WHERE NOT EXISTS (
        SELECT 1 FROM work_item_approvals
        WHERE work_item_id = NEW.id AND status = 'pending'
      );
    END;

    CREATE TRIGGER IF NOT EXISTS trg_approval_active_requires_pending_on_insert
    AFTER INSERT ON work_items
    WHEN NEW.approval_active = 1
    BEGIN
      SELECT RAISE(ABORT, 'approval_active=1 requires at least one pending approver')
      WHERE NOT EXISTS (
        SELECT 1 FROM work_item_approvals
        WHERE work_item_id = NEW.id AND status = 'pending'
      );
    END;
  `);

  const outsideEnum = db.prepare(
    `SELECT COUNT(*) AS n FROM work_items WHERE status NOT IN (${TEN_STATES.map(() => '?').join(',')})`,
  ).get(...TEN_STATES).n;
  if (outsideEnum > 0) {
    throw new Error(`Migration invariant broken: ${outsideEnum} rows with status outside new enum`);
  }
}
