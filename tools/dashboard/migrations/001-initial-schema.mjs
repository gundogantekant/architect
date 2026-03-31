/**
 * Initial schema — creates all tables and migrates data from JSON files.
 */
import { readFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export function up(db, workDir) {
  // --- Tables ---
  db.exec(`
    CREATE TABLE work_items (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT NOT NULL DEFAULT '',
      epic_id TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      depends_on TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE work_item_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id TEXT NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
      logged_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE epics (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      priority TEXT NOT NULL DEFAULT 'medium',
      description TEXT NOT NULL DEFAULT '',
      acceptance_criteria TEXT NOT NULL DEFAULT '',
      target_date TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE epic_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      logged_at TEXT NOT NULL,
      summary TEXT NOT NULL
    );

    CREATE TABLE sequences (
      name TEXT PRIMARY KEY,
      next_val INTEGER NOT NULL
    );

    CREATE TABLE dispatches (
      id TEXT PRIMARY KEY,
      work_item_id TEXT,
      epic_id TEXT,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      session_id TEXT,
      cost_usd REAL
    );

    CREATE TABLE terminals (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'claude',
      work_item_id TEXT,
      epic_id TEXT,
      project_key TEXT NOT NULL,
      project_path TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT 'acceptEdits',
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      exited_at TEXT
    );

    CREATE TABLE cli_sessions (
      id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL,
      work_item_id TEXT,
      epic_id TEXT,
      title TEXT NOT NULL,
      pid INTEGER NOT NULL,
      status TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      exited_at TEXT
    );

    CREATE TABLE preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE INDEX idx_work_items_project_key ON work_items(project_key);
    CREATE INDEX idx_work_items_status ON work_items(status);
    CREATE INDEX idx_work_items_epic_id ON work_items(epic_id);
    CREATE INDEX idx_work_item_logs_work_item_id ON work_item_logs(work_item_id);
    CREATE INDEX idx_epic_logs_epic_id ON epic_logs(epic_id);
  `);

  // --- Data migration from JSON ---
  const backlogPath = join(workDir, 'backlog.json');
  if (existsSync(backlogPath)) {
    const bl = JSON.parse(readFileSync(backlogPath, 'utf8'));

    // Apply legacy migrations to in-memory data
    if (bl.version < 3) {
      if (!bl.next_epic_id) bl.next_epic_id = 1;
      if (!bl.epics) bl.epics = [];
      bl.version = 3;
    }
    if (bl.version < 4) {
      for (const group of Object.values(bl.projects || {})) {
        if (!group.items) continue;
        for (const item of group.items) {
          if ('blocked_by' in item) {
            item.depends_on = item.blocked_by ? [item.blocked_by] : [];
            delete item.blocked_by;
          } else if (!item.depends_on) {
            item.depends_on = [];
          }
        }
      }
      bl.version = 4;
    }

    // Insert work items
    const insertItem = db.prepare(`
      INSERT INTO work_items (id, project_key, title, status, priority, description, epic_id, tags, depends_on, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertItemLog = db.prepare(`
      INSERT INTO work_item_logs (work_item_id, logged_at, summary)
      VALUES (?, ?, ?)
    `);

    for (const [projectKey, group] of Object.entries(bl.projects || {})) {
      if (!group.items) continue;
      for (const item of group.items) {
        const createdAt = toISO(item.created || item.created_at);
        const updatedAt = toISO(item.updated || item.updated_at);
        insertItem.run(
          item.id, projectKey, item.title,
          item.status || 'open', item.priority || 'medium',
          item.description || '', item.epic_id || null,
          JSON.stringify(item.tags || []),
          JSON.stringify(item.depends_on || []),
          createdAt, updatedAt,
        );
        for (const log of (item.session_log || [])) {
          insertItemLog.run(item.id, toISO(log.date), log.summary);
        }
      }
    }

    // Insert epics
    const insertEpic = db.prepare(`
      INSERT INTO epics (id, title, status, priority, description, acceptance_criteria, target_date, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertEpicLog = db.prepare(`
      INSERT INTO epic_logs (epic_id, logged_at, summary)
      VALUES (?, ?, ?)
    `);

    for (const epic of (bl.epics || [])) {
      const createdAt = toISO(epic.created || epic.created_at);
      const updatedAt = toISO(epic.updated || epic.updated_at);
      insertEpic.run(
        epic.id, epic.title,
        epic.status || 'draft', epic.priority || 'medium',
        epic.description || '', epic.acceptance_criteria || '',
        epic.target_date || null,
        JSON.stringify(epic.tags || []),
        createdAt, updatedAt,
      );
      for (const log of (epic.session_log || [])) {
        insertEpicLog.run(epic.id, toISO(log.date), log.summary);
      }
    }

    // Seed sequences
    db.prepare('INSERT INTO sequences (name, next_val) VALUES (?, ?)').run('work_item', bl.next_id || 1);
    db.prepare('INSERT INTO sequences (name, next_val) VALUES (?, ?)').run('epic', bl.next_epic_id || 1);

    // Rename original
    try { renameSync(backlogPath, backlogPath + '.bak'); } catch {}
  } else {
    // No backlog — seed default sequences
    db.prepare('INSERT INTO sequences (name, next_val) VALUES (?, ?)').run('work_item', 1);
    db.prepare('INSERT INTO sequences (name, next_val) VALUES (?, ?)').run('epic', 1);
  }

  // Migrate sessions.json
  const sessionsPath = join(workDir, 'sessions.json');
  if (existsSync(sessionsPath)) {
    const data = JSON.parse(readFileSync(sessionsPath, 'utf8'));

    const insertDispatch = db.prepare(`
      INSERT OR IGNORE INTO dispatches (id, work_item_id, epic_id, project_key, project_path, title, permission_mode, status, started_at, completed_at, session_id, cost_usd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const d of Object.values(data.dispatches || {})) {
      const permMode = d.skip_permissions ? 'dangerouslySkipPermissions' : 'acceptEdits';
      insertDispatch.run(
        d.id, d.work_item_id || null, d.epic_id || null,
        d.project_key, d.project_path || '', d.title || '',
        permMode, d.status, d.started_at, d.completed_at || null,
        d.session_id || null, d.cost_usd || null,
      );
    }

    const insertTerminal = db.prepare(`
      INSERT OR IGNORE INTO terminals (id, type, work_item_id, epic_id, project_key, project_path, title, permission_mode, status, started_at, exited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const t of Object.values(data.terminals || {})) {
      const permMode = t.skip_permissions ? 'dangerouslySkipPermissions' : 'acceptEdits';
      insertTerminal.run(
        t.id, t.type || 'claude', t.work_item_id || null, t.epic_id || null,
        t.project_key, t.project_path || '', t.title || '',
        permMode, t.status, t.started_at, t.exited_at || null,
      );
    }

    const insertCli = db.prepare(`
      INSERT OR IGNORE INTO cli_sessions (id, project_key, work_item_id, epic_id, title, pid, status, registered_at, exited_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const c of Object.values(data.cli_sessions || {})) {
      insertCli.run(
        c.id, c.project_key, c.work_item_id || null, c.epic_id || null,
        c.title, c.pid, c.status, c.registered_at, c.exited_at || null,
      );
    }

    // Rename original
    try { renameSync(sessionsPath, sessionsPath + '.bak'); } catch {}
  }

  // Default preferences
  db.prepare('INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)').run('default_permission_mode', 'acceptEdits');
  db.prepare('INSERT OR IGNORE INTO preferences (key, value) VALUES (?, ?)').run('default_skip_permissions', 'true');
}

function toISO(dateStr) {
  if (!dateStr) return new Date().toISOString();
  // Already ISO 8601 with time component
  if (dateStr.includes('T')) return dateStr;
  // YYYY-MM-DD → full ISO
  return dateStr + 'T00:00:00.000Z';
}
