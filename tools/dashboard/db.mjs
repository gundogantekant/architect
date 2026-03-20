/**
 * Database abstraction layer for the architect dashboard.
 * Owns the SQLite connection, WAL mode, migrations, and all domain queries.
 */
import Database from 'better-sqlite3';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let db = null;

// --- Init & migrations ---

export async function initDatabaseAsync(workDir, migrationsDir) {
  const dbPath = join(workDir, 'architect.db');
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  const files = readdirSync(migrationsDir)
    .filter(f => /^\d{3}-.+\.mjs$/.test(f))
    .sort();

  for (const file of files) {
    const version = parseInt(file.slice(0, 3), 10);
    if (applied.has(version)) continue;

    console.log(`Applying migration ${file}...`);
    const migration = await import(join(migrationsDir, file));
    db.transaction(() => {
      migration.up(db, workDir);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        version, new Date().toISOString()
      );
    })();
    console.log(`Migration ${file} applied.`);
  }

  return db;
}

export function getDb() { return db; }

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Sequences ---

export function nextWorkItemId() {
  const row = db.prepare('SELECT next_val FROM sequences WHERE name = ?').get('work_item');
  const val = row ? row.next_val : 1;
  db.prepare('UPDATE sequences SET next_val = ? WHERE name = ?').run(val + 1, 'work_item');
  return `W-${String(val).padStart(3, '0')}`;
}

export function nextEpicId() {
  const row = db.prepare('SELECT next_val FROM sequences WHERE name = ?').get('epic');
  const val = row ? row.next_val : 1;
  db.prepare('UPDATE sequences SET next_val = ? WHERE name = ?').run(val + 1, 'epic');
  return `E-${String(val).padStart(3, '0')}`;
}

// --- Work Items ---

export function getWorkItem(id) {
  const row = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateWorkItem(row);
}

export function getWorkItemsByProject(projectKey) {
  const rows = db.prepare('SELECT * FROM work_items WHERE project_key = ?').all(projectKey);
  return rows.map(hydrateWorkItem);
}

export function getWorkItemsByEpic(epicId) {
  const rows = db.prepare('SELECT * FROM work_items WHERE epic_id = ?').all(epicId);
  return rows.map(hydrateWorkItem);
}

export function getAllWorkItems() {
  const rows = db.prepare('SELECT * FROM work_items').all();
  return rows.map(hydrateWorkItem);
}

export function createWorkItem({ project_key, title, status, priority, description, tags, epic_id }) {
  const id = nextWorkItemId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO work_items (id, project_key, title, status, priority, description, epic_id, tags, depends_on, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)
  `).run(id, project_key, title, status || 'open', priority || 'medium', description || '', epic_id || null, JSON.stringify(tags || []), now, now);

  addWorkItemLog(id, 'Created');

  // If epic_id is set, the link is implicit via the epic_id column

  return getWorkItem(id);
}

export function updateWorkItem(id, fields) {
  const allowed = ['title', 'status', 'priority', 'description', 'tags', 'depends_on', 'epic_id'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      if (key === 'tags' || key === 'depends_on') {
        sets.push(`${key} = ?`);
        values.push(JSON.stringify(fields[key]));
      } else {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
  }
  if (sets.length === 0) return getWorkItem(id);
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE work_items SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getWorkItem(id);
}

export function deleteWorkItem(id) {
  const item = getWorkItem(id);
  if (!item) return null;
  db.prepare('DELETE FROM work_items WHERE id = ?').run(id);
  return item;
}

export function addWorkItemLog(workItemId, summary) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO work_item_logs (work_item_id, logged_at, summary) VALUES (?, ?, ?)').run(workItemId, now, summary);
  db.prepare('UPDATE work_items SET updated_at = ? WHERE id = ?').run(now, workItemId);
}

export function getWorkItemLogs(workItemId) {
  return db.prepare('SELECT * FROM work_item_logs WHERE work_item_id = ? ORDER BY id').all(workItemId);
}

// --- Dependencies ---

export function addDependency(itemId, targetId) {
  const item = getWorkItem(itemId);
  if (!item) throw new Error('Work item not found');

  // Verify target exists
  const target = getWorkItem(targetId);
  if (!target) throw new Error(`Target ${targetId} not found`);

  // Check already present
  if (item.depends_on.includes(targetId)) return item;

  // Cycle detection
  if (detectCycle(itemId, targetId)) {
    throw new Error(`Circular dependency: ${itemId} → ${targetId} would create a cycle`);
  }

  const deps = [...item.depends_on, targetId];
  return updateWorkItem(itemId, { depends_on: deps });
}

export function removeDependency(itemId, targetId) {
  const item = getWorkItem(itemId);
  if (!item) throw new Error('Work item not found');
  const deps = item.depends_on.filter(d => d !== targetId);
  return updateWorkItem(itemId, { depends_on: deps });
}

function detectCycle(itemId, targetId) {
  const visited = new Set();
  const stack = [targetId];
  while (stack.length) {
    const current = stack.pop();
    if (current === itemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const row = db.prepare('SELECT depends_on FROM work_items WHERE id = ?').get(current);
    if (row) {
      const deps = JSON.parse(row.depends_on || '[]');
      for (const dep of deps) stack.push(dep);
    }
  }
  return false;
}

// --- Epics ---

export function listEpics() {
  const rows = db.prepare('SELECT * FROM epics').all();
  return rows.map(hydrateEpic);
}

export function getEpic(id) {
  const row = db.prepare('SELECT * FROM epics WHERE id = ?').get(id);
  if (!row) return null;
  return hydrateEpic(row);
}

export function createEpic({ title, priority, description, acceptance_criteria, target_date, tags }) {
  const id = nextEpicId();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO epics (id, title, status, priority, description, acceptance_criteria, target_date, tags, created_at, updated_at)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, priority || 'medium', description || '', acceptance_criteria || '', target_date || null, JSON.stringify(tags || []), now, now);

  addEpicLog(id, 'Created');
  return getEpic(id);
}

export function updateEpic(id, fields) {
  const allowed = ['title', 'status', 'priority', 'description', 'acceptance_criteria', 'target_date', 'tags'];
  const sets = [];
  const values = [];
  for (const key of allowed) {
    if (key in fields) {
      if (key === 'tags') {
        sets.push(`${key} = ?`);
        values.push(JSON.stringify(fields[key]));
      } else {
        sets.push(`${key} = ?`);
        values.push(fields[key]);
      }
    }
  }
  if (sets.length === 0) return getEpic(id);
  sets.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(id);
  db.prepare(`UPDATE epics SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  return getEpic(id);
}

export function deleteEpic(id) {
  const epic = getEpic(id);
  if (!epic) return null;
  // Unlink all items
  db.prepare('UPDATE work_items SET epic_id = NULL WHERE epic_id = ?').run(id);
  db.prepare('DELETE FROM epics WHERE id = ?').run(id);
  return epic;
}

export function addEpicLog(epicId, summary) {
  const now = new Date().toISOString();
  db.prepare('INSERT INTO epic_logs (epic_id, logged_at, summary) VALUES (?, ?, ?)').run(epicId, now, summary);
  db.prepare('UPDATE epics SET updated_at = ? WHERE id = ?').run(now, epicId);
}

export function getEpicLogs(epicId) {
  return db.prepare('SELECT * FROM epic_logs WHERE epic_id = ? ORDER BY id').all(epicId);
}

export function linkItemsToEpic(epicId, workItemIds) {
  const epic = getEpic(epicId);
  if (!epic) throw new Error('Epic not found');

  let linked = 0;
  const now = new Date().toISOString();
  const update = db.prepare('UPDATE work_items SET epic_id = ?, updated_at = ? WHERE id = ? AND (epic_id IS NULL OR epic_id = ? OR epic_id = \'\')');

  for (const wid of workItemIds) {
    const item = getWorkItem(wid);
    if (!item) continue;
    if (item.epic_id && item.epic_id !== epicId) continue; // already linked to different epic
    const result = update.run(epicId, now, wid, epicId);
    if (result.changes > 0) linked++;
  }

  db.prepare('UPDATE epics SET updated_at = ? WHERE id = ?').run(now, epicId);
  return linked;
}

export function unlinkItemFromEpic(epicId, workItemId) {
  const now = new Date().toISOString();
  db.prepare('UPDATE work_items SET epic_id = NULL, updated_at = ? WHERE id = ? AND epic_id = ?').run(now, workItemId, epicId);
  db.prepare('UPDATE epics SET updated_at = ? WHERE id = ?').run(now, epicId);
}

// Derived fields for epics
export function getEpicWorkItemIds(epicId) {
  return db.prepare('SELECT id FROM work_items WHERE epic_id = ?').all(epicId).map(r => r.id);
}

export function getEpicProjectKeys(epicId) {
  return db.prepare('SELECT DISTINCT project_key FROM work_items WHERE epic_id = ?').all(epicId).map(r => r.project_key).sort();
}

// --- Sessions: Dispatches ---

export function saveDispatch(d) {
  db.prepare(`
    INSERT OR REPLACE INTO dispatches (id, work_item_id, epic_id, project_key, project_path, title, permission_mode, status, started_at, completed_at, session_id, cost_usd)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(d.id, d.work_item_id || null, d.epic_id || null, d.project_key, d.project_path || '', d.title || '', d.permission_mode || 'acceptEdits', d.status, d.started_at, d.completed_at || null, d.session_id || null, d.cost_usd || null);
}

export function deleteDispatch(id) {
  db.prepare('DELETE FROM dispatches WHERE id = ?').run(id);
}

export function getPersistedDispatches() {
  return db.prepare('SELECT * FROM dispatches').all();
}

// --- Sessions: Terminals ---

export function saveTerminal(t) {
  db.prepare(`
    INSERT OR REPLACE INTO terminals (id, type, work_item_id, epic_id, project_key, project_path, title, permission_mode, status, started_at, exited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.id, t.type || 'claude', t.work_item_id || null, t.epic_id || null, t.project_key, t.project_path || '', t.title || '', t.permission_mode || 'acceptEdits', t.status, t.started_at, t.exited_at || null);
}

export function deleteTerminal(id) {
  db.prepare('DELETE FROM terminals WHERE id = ?').run(id);
}

export function getPersistedTerminals() {
  return db.prepare('SELECT * FROM terminals').all();
}

// --- Sessions: CLI ---

export function saveCliSession(c) {
  db.prepare(`
    INSERT OR REPLACE INTO cli_sessions (id, project_key, work_item_id, epic_id, title, pid, status, registered_at, exited_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(c.id, c.project_key, c.work_item_id || null, c.epic_id || null, c.title, c.pid, c.status, c.registered_at, c.exited_at || null);
}

export function deleteCliSession(id) {
  db.prepare('DELETE FROM cli_sessions WHERE id = ?').run(id);
}

export function getPersistedCliSessions() {
  return db.prepare('SELECT * FROM cli_sessions').all();
}

// --- Mark running sessions as interrupted on shutdown ---

export function markRunningAsInterrupted() {
  const now = new Date().toISOString();
  db.prepare("UPDATE dispatches SET status = 'interrupted', completed_at = ? WHERE status = 'running'").run(now);
  db.prepare("UPDATE terminals SET status = 'interrupted', exited_at = ? WHERE status = 'running'").run(now);
}

// --- Preferences ---

export function getPreference(key) {
  const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setPreference(key, value) {
  db.prepare('INSERT OR REPLACE INTO preferences (key, value) VALUES (?, ?)').run(key, value);
}

export function getAllPreferences() {
  const rows = db.prepare('SELECT * FROM preferences').all();
  const prefs = {};
  for (const row of rows) prefs[row.key] = row.value;
  return prefs;
}

// --- Backlog reconstruction (legacy shape for API compat) ---

export function getBacklog(orgFilter) {
  let items;
  if (orgFilter) {
    items = db.prepare('SELECT * FROM work_items WHERE project_key LIKE ?').all(orgFilter.toLowerCase() + '/%');
  } else {
    items = db.prepare('SELECT * FROM work_items').all();
  }

  // Group by project_key
  const projects = {};
  for (const row of items) {
    const item = hydrateWorkItem(row);
    // Attach session_log
    item.session_log = getWorkItemLogs(item.id).map(l => ({
      date: l.logged_at,
      summary: l.summary,
    }));
    if (!projects[row.project_key]) projects[row.project_key] = { items: [] };
    projects[row.project_key].items.push(item);
  }

  // Epics
  const epics = listEpics().map(epic => {
    epic.work_item_ids = getEpicWorkItemIds(epic.id);
    epic.project_keys = getEpicProjectKeys(epic.id);
    epic.session_log = getEpicLogs(epic.id).map(l => ({
      date: l.logged_at,
      summary: l.summary,
    }));
    return epic;
  });

  return { projects, epics };
}

// --- Single work item with full details ---

export function getWorkItemFull(id) {
  const item = getWorkItem(id);
  if (!item) return null;
  item.session_log = getWorkItemLogs(id).map(l => ({
    date: l.logged_at,
    summary: l.summary,
  }));
  // Find project_key
  const row = db.prepare('SELECT project_key FROM work_items WHERE id = ?').get(id);
  if (row) item.project_key = row.project_key;
  return item;
}

// --- Epic with resolved items ---

export function getEpicFull(id) {
  const epic = getEpic(id);
  if (!epic) return null;
  epic.work_item_ids = getEpicWorkItemIds(id);
  epic.project_keys = getEpicProjectKeys(id);
  epic.session_log = getEpicLogs(id).map(l => ({
    date: l.logged_at,
    summary: l.summary,
  }));
  // Resolve items
  const resolved = db.prepare('SELECT * FROM work_items WHERE epic_id = ?').all(id).map(row => {
    const item = hydrateWorkItem(row);
    item.project_key = row.project_key;
    item.session_log = getWorkItemLogs(item.id).map(l => ({
      date: l.logged_at,
      summary: l.summary,
    }));
    return item;
  });
  epic.resolved_items = resolved;
  const done = resolved.filter(i => i.status === 'done').length;
  epic.progress = { done, total: resolved.length };
  return epic;
}

// --- Hydration helpers ---

function hydrateWorkItem(row) {
  return {
    id: row.id,
    project_key: row.project_key,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    epic_id: row.epic_id || '',
    tags: JSON.parse(row.tags || '[]'),
    depends_on: JSON.parse(row.depends_on || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function hydrateEpic(row) {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    description: row.description,
    acceptance_criteria: row.acceptance_criteria,
    target_date: row.target_date || '',
    tags: JSON.parse(row.tags || '[]'),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
