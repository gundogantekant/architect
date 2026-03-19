#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, resolve, extname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';

const CLAUDE_BIN = (() => {
  try {
    return execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
  } catch {
    console.warn('WARNING: "claude" binary not found in PATH. Terminal and dispatch features will fail.');
    return 'claude';
  }
})();

const ROOT = resolve(import.meta.dirname, '..', '..');
const PORTFOLIO = join(ROOT, 'portfolio');
const WORK = join(ROOT, 'work');

const port = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 3777;
})();

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function text(res, data, mime = 'text/plain', status = 200) {
  res.writeHead(status, { 'Content-Type': mime });
  res.end(data);
}

function err(res, msg, status = 404) { json(res, { error: msg }, status); }

function safe(segment) {
  return !segment.includes('..') && !segment.includes('/') && !segment.includes('\\');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function listDirs(base) {
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

async function listFiles(base) {
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter(e => e.isFile()).map(e => e.name);
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

// --- Session persistence ---
const SESSIONS_FILE = join(WORK, 'sessions.json');

function loadSessions() {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    return { dispatches: data.dispatches || {}, terminals: data.terminals || {} };
  } catch {
    return { dispatches: {}, terminals: {} };
  }
}

let _saveSessionsTimer = null;
function saveSessions() {
  if (_saveSessionsTimer) return;
  _saveSessionsTimer = setTimeout(() => {
    _saveSessionsTimer = null;
    const data = { dispatches: {}, terminals: {} };
    for (const [id, d] of dispatches) {
      data.dispatches[id] = {
        id, work_item_id: d.work_item_id, epic_id: d.epic_id,
        project_key: d.project_key, project_path: d.project_path,
        title: d.title || d.work_item_id, status: d.status,
        started_at: d.started_at, completed_at: d.completed_at,
        session_id: d.session_id || null, cost_usd: d.cost_usd || null,
        skip_permissions: d.skip_permissions || false,
      };
    }
    for (const [id, t] of terminals) {
      data.terminals[id] = {
        id, type: t.type || 'claude', work_item_id: t.work_item_id, epic_id: t.epic_id,
        project_key: t.project_key, project_path: t.project_path,
        title: t.title, status: t.status,
        started_at: t.started_at, exited_at: t.exited_at,
        skip_permissions: t.skip_permissions || false,
      };
    }
    writeFile(SESSIONS_FILE, JSON.stringify(data, null, 2) + '\n').catch(() => {});
  }, 500);
}

// --- Dispatch registry ---
const dispatches = new Map();

// --- Terminal registry ---
const terminals = new Map();
const SCROLLBACK_LIMIT = 100 * 1024; // 100KB ring buffer

// Restore persisted sessions on startup
{
  const persisted = loadSessions();
  for (const [id, d] of Object.entries(persisted.dispatches)) {
    dispatches.set(id, {
      ...d,
      output: [],
      lastLines: [],
      listeners: new Set(),
      process: null,
      status: d.status === 'running' ? 'interrupted' : d.status,
    });
  }
  for (const [id, t] of Object.entries(persisted.terminals)) {
    terminals.set(id, {
      ...t,
      ptyProcess: null,
      scrollback: '',
      wsClients: new Set(),
      status: t.status === 'running' ? 'interrupted' : t.status,
    });
  }
  if (Object.keys(persisted.dispatches).length || Object.keys(persisted.terminals).length) {
    saveSessions();
    console.log(`Restored ${Object.keys(persisted.dispatches).length} dispatches, ${Object.keys(persisted.terminals).length} terminals from sessions.json`);
  }
}

function extractStreamText(evt) {
  if (evt.type === 'assistant' && evt.message?.content) {
    return evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (evt.type === 'content_block_delta' && evt.delta?.text) return evt.delta.text;
  if (evt.type === 'content_block_start' && evt.content_block?.text) return evt.content_block.text;
  if (evt.type === 'result') return `--- Agent finished ---`;
  return null;
}

function killProcess(proc, signal = 'SIGTERM') {
  try { proc.kill(signal); } catch {}
}

function killProcessGraceful(proc) {
  killProcess(proc, 'SIGTERM');
  return setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, 5000);
}

async function resolveProjectPath(projectKey) {
  const registry = await readJson(join(PORTFOLIO, 'registry.json'));
  for (const [path, entry] of Object.entries(registry.entries)) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    if (key === projectKey) return path;
  }
  return null;
}

async function loadPortfolioContext(projectKey) {
  const [org, project, component] = projectKey.split('/');
  if (!org || !project || !component) return null;
  const [entry, orgData] = await Promise.all([
    readJson(join(PORTFOLIO, org, project, component + '.json')).catch(() => null),
    readJson(join(PORTFOLIO, org, 'organization.json')).catch(() => null),
  ]);
  return (entry || orgData) ? { entry, org: orgData } : null;
}

async function loadWorkItem(workItemId, projectKey) {
  try {
    const bl = await readJson(join(WORK, 'backlog.json'));
    const group = bl.projects[projectKey];
    if (!group || !group.items) return null;
    return group.items.find(i => i.id === workItemId) || null;
  } catch {
    return null;
  }
}

async function migrateBacklog(bl, blPath) {
  let changed = false;
  if (bl.version < 3) {
    bl.version = 3;
    if (!bl.next_epic_id) bl.next_epic_id = 1;
    if (!bl.epics) bl.epics = [];
    changed = true;
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
    changed = true;
  }
  if (changed) await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
  return bl;
}

function detectCycle(itemId, targetId, projects) {
  const visited = new Set();
  const stack = [targetId];
  while (stack.length) {
    const current = stack.pop();
    if (current === itemId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const group of Object.values(projects)) {
      if (!group.items) continue;
      const item = group.items.find(i => i.id === current);
      if (item && item.depends_on) {
        for (const dep of item.depends_on) stack.push(dep);
      }
    }
  }
  return false;
}

function topoSort(items) {
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  const itemMap = new Map(items.map(i => [i.id, i]));
  const inDegree = new Map(items.map(i => [i.id, 0]));
  for (const item of items) {
    for (const dep of (item.depends_on || [])) {
      if (itemMap.has(dep)) {
        inDegree.set(item.id, (inDegree.get(item.id) || 0) + 1);
      }
    }
  }
  const queue = items.filter(i => inDegree.get(i.id) === 0)
    .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || a.id.localeCompare(b.id));
  const sorted = [];
  const processed = new Set();
  while (queue.length) {
    const item = queue.shift();
    sorted.push(item);
    processed.add(item.id);
    const next = items.filter(i => !processed.has(i.id) && (i.depends_on || []).every(d => !itemMap.has(d) || processed.has(d)))
      .sort((a, b) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2) || a.id.localeCompare(b.id));
    for (const n of next) {
      if (!processed.has(n.id) && !queue.includes(n)) queue.push(n);
    }
  }
  const remaining = items.filter(i => !processed.has(i.id));
  return [...sorted, ...remaining];
}

function resolveEpicItems(epic, backlog) {
  const resolved = [];
  for (const wid of epic.work_item_ids) {
    for (const [key, group] of Object.entries(backlog.projects)) {
      if (!group.items) continue;
      const item = group.items.find(i => i.id === wid);
      if (item) {
        resolved.push({ ...item, project_key: key });
        break;
      }
    }
  }
  return resolved;
}

function recomputeProjectKeys(epic, backlog) {
  const keys = new Set();
  for (const wid of epic.work_item_ids) {
    for (const [key, group] of Object.entries(backlog.projects)) {
      if (!group.items) continue;
      if (group.items.some(i => i.id === wid)) {
        keys.add(key);
        break;
      }
    }
  }
  epic.project_keys = [...keys].sort();
}

async function loadEpicPlanSnippet(epicId) {
  try {
    const content = await readFile(join(WORK, 'epics', epicId, 'plan.md'), 'utf8');
    return content.slice(0, 500);
  } catch {
    return '';
  }
}

function buildDispatchPrompt({ workItem, projectKey, projectPath, additionalInstructions, portfolio, epicContext, relatedProjects }) {
  const sections = [];

  // --- Scope ---
  const scopeLines = ['# Scope', ''];
  const org = projectKey.split('/')[0];
  if (org && org !== '–') scopeLines.push(`- **Organization**: ${org}`);
  scopeLines.push(`- **Project**: ${projectKey}`);
  if (workItem) scopeLines.push(`- **Work Item**: ${workItem.id}`);
  if (epicContext) scopeLines.push(`- **Epic**: ${epicContext.id}`);
  sections.push(scopeLines.join('\n'));

  // --- Layer 1: Project Context (first — stack, structure, conventions, org rules) ---
  if (portfolio && portfolio.entry) {
    const e = portfolio.entry;
    const lines = ['# Project Context', ''];
    if (e.guidance?.stack_summary) lines.push(`**Stack**: ${e.guidance.stack_summary}`);
    if (e.guidance?.structure && e.guidance.structure.length) {
      lines.push('', '**Structure**:');
      for (const s of e.guidance.structure) lines.push(`- ${s}`);
    }
    if (e.guidance?.conventions && e.guidance.conventions.length) {
      lines.push('', '**Conventions**:');
      for (const c of e.guidance.conventions) lines.push(`- ${c}`);
    }
    if (e.agents?.dispatch_notes && Object.keys(e.agents.dispatch_notes).length) {
      lines.push('', '**Agent Notes**:');
      for (const [agent, note] of Object.entries(e.agents.dispatch_notes)) {
        lines.push(`- ${agent}: ${note}`);
      }
    }
    if (e.brief?.purpose) lines.push(`\n**Purpose**: ${e.brief.purpose}`);
    if (e.brief?.domain) lines.push(`**Domain**: ${e.brief.domain}`);
    if (e.brief?.users) lines.push(`**Users**: ${e.brief.users}`);
    sections.push(lines.join('\n'));
  }

  if (portfolio && portfolio.org) {
    const o = portfolio.org;
    const lines = ['# Organization Conventions', ''];
    if (o.conventions?.branch_prefix) lines.push(`- Branch prefix: ${o.conventions.branch_prefix}`);
    if (o.conventions?.pr_title_pattern) lines.push(`- PR title pattern: ${o.conventions.pr_title_pattern}`);
    if (o.rules && o.rules.length) {
      lines.push('', '**Rules**:');
      for (const r of o.rules) lines.push(`- ${r}`);
    }
    sections.push(lines.join('\n'));
  }

  // Related projects (cross-project awareness for epic dispatches)
  if (relatedProjects && relatedProjects.length) {
    const lines = ['# Related Projects', ''];
    for (const rp of relatedProjects) {
      lines.push(`## ${rp.key}`);
      if (rp.entry?.guidance?.stack_summary) lines.push(`- Stack: ${rp.entry.guidance.stack_summary}`);
      if (rp.entry?.brief?.purpose) lines.push(`- Purpose: ${rp.entry.brief.purpose}`);
      lines.push('');
    }
    sections.push(lines.join('\n'));
  }

  // --- Layer 2: Task Context (second — work item details, description, session log) ---
  if (workItem) {
    sections.push(`# Task\n\nWork on backlog item ${workItem.id}: ${workItem.title}`);

    const lines = ['# Work Item', ''];
    lines.push(`- **Status**: ${workItem.status}`);
    lines.push(`- **Priority**: ${workItem.priority}`);
    if (workItem.tags && workItem.tags.length) lines.push(`- **Tags**: ${workItem.tags.join(', ')}`);
    if (workItem.depends_on && workItem.depends_on.length) lines.push(`- **Depends on**: ${workItem.depends_on.join(', ')}`);
    if (workItem.description) lines.push(`- **Description**: ${workItem.description}`);
    if (workItem.session_log && workItem.session_log.length) {
      lines.push('', '**Session Log**:');
      for (const entry of workItem.session_log) {
        lines.push(`- ${entry.date}: ${entry.summary}`);
      }
    }
    sections.push(lines.join('\n'));
  } else if (additionalInstructions) {
    sections.push(`# Task\n\n${additionalInstructions}`);
  }

  // --- Layer 3: Epic Context (third — lightweight: title, status, progress, plan snippet, AC) ---
  if (epicContext) {
    const lines = ['# Epic Context', ''];
    lines.push(`- **Epic**: ${epicContext.id} — ${epicContext.title}`);
    lines.push(`- **Status**: ${epicContext.status}`);
    lines.push(`- **Progress**: ${epicContext.progress}`);
    if (epicContext.acceptance_criteria) lines.push(`- **Acceptance Criteria**: ${epicContext.acceptance_criteria}`);
    if (epicContext.items && epicContext.items.length) {
      lines.push('', '**Linked Items**:');
      for (const item of epicContext.items) {
        lines.push(`- ${item.id} [${item.status}] (${item.project_key}): ${item.title}`);
      }
    }
    if (epicContext.plan_snippet) {
      lines.push('', '**Plan (excerpt)**:', epicContext.plan_snippet);
    }
    sections.push(lines.join('\n'));
  }

  // --- Constraints ---
  if (workItem && additionalInstructions) {
    sections.push(`# Constraints\n\n${additionalInstructions}`);
  }

  // --- Environment (always included) ---
  {
    const envLines = ['# Environment', ''];
    envLines.push(`You are running in the target project directory: ${projectPath || '(unknown)'}`);
    envLines.push(`The architect project (portfolio, backlog, domain rules) is at: ${ROOT}`);
    envLines.push(`- Backlog: ${ROOT}/work/backlog.json`);
    envLines.push(`- Portfolio: ${ROOT}/portfolio/`);
    envLines.push(`- Dashboard API: http://127.0.0.1:${port}`);
    envLines.push('');
    envLines.push('Use the architect project to look up cross-project context, related tasks, or domain rules when needed. Your primary work should happen in the current directory (the target project).');
    sections.push(envLines.join('\n'));
  }

  // --- Tracking (only when workItem is present) ---
  if (workItem) {
    const trackLines = ['# Tracking', ''];
    const epicLine = epicContext ? ` (part of ${epicContext.id}: ${epicContext.title})` : '';
    trackLines.push(`You were dispatched for ${workItem.id}: ${workItem.title}${epicLine}.`);
    trackLines.push('');
    trackLines.push(`- Reference this work item in commit messages (e.g. "[${workItem.id}] ...")`);
    trackLines.push(`- When your work is complete, add a session log entry:`);
    trackLines.push(`  curl -s -X POST http://127.0.0.1:${port}/api/work-items/${workItem.id}/log \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"summary": "..."}'`);
    trackLines.push(`- If you complete the task fully, update its status:`);
    trackLines.push(`  curl -s -X PATCH http://127.0.0.1:${port}/api/work-items/${workItem.id} \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"status": "done"}'`);
    trackLines.push('- Stay within the scope of this task. If you discover adjacent work needed, note it but do not pursue it.');
    sections.push(trackLines.join('\n'));
  }

  return sections.join('\n\n');
}

const routes = [
  // Static: index.html
  [/^\/$/, 'GET', async (_m, _req, res) => {
    const html = await readFile(join(import.meta.dirname, 'index.html'), 'utf8');
    text(res, html, 'text/html');
  }],

  // Registry
  [/^\/api\/registry$/, 'GET', async (_m, _req, res) => {
    json(res, await readJson(join(PORTFOLIO, 'registry.json')));
  }],

  // List orgs
  [/^\/api\/orgs$/, 'GET', async (_m, _req, res) => {
    json(res, await listDirs(PORTFOLIO));
  }],

  // Org detail
  [/^\/api\/org\/([a-zA-Z0-9_-]+)$/, 'GET', async (m, _req, res) => {
    if (!safe(m[1])) return err(res, 'invalid org', 400);
    json(res, await readJson(join(PORTFOLIO, m[1], 'organization.json')));
  }],

  // Org projects
  [/^\/api\/org\/([a-zA-Z0-9_-]+)\/projects$/, 'GET', async (m, _req, res) => {
    if (!safe(m[1])) return err(res, 'invalid org', 400);
    json(res, await listDirs(join(PORTFOLIO, m[1])));
  }],

  // Project files
  [/^\/api\/project\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/, 'GET', async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2])) return err(res, 'invalid path', 400);
    json(res, await listFiles(join(PORTFOLIO, m[1], m[2])));
  }],

  // Component JSON
  [/^\/api\/component\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, 'GET', async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
    const name = m[3].endsWith('.json') ? m[3] : m[3] + '.json';
    json(res, await readJson(join(PORTFOLIO, m[1], m[2], name)));
  }],

  // Doc (markdown)
  [/^\/api\/doc\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, 'GET', async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
    const content = await readFile(join(PORTFOLIO, m[1], m[2], m[3]), 'utf8');
    text(res, content, 'text/plain');
  }],

  // Backlog
  [/^\/api\/backlog$/, 'GET', async (_m, req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const orgFilter = reqUrl.searchParams.get('org');
    const bl = await readJson(join(WORK, 'backlog.json'));
    if (orgFilter) {
      const prefix = orgFilter.toLowerCase() + '/';
      const filtered = {};
      for (const [key, group] of Object.entries(bl.projects)) {
        if (key.toLowerCase().startsWith(prefix)) filtered[key] = group;
      }
      bl.projects = filtered;
    }
    json(res, bl);
  }],

  // --- Work item endpoints ---

  // Create work item
  [/^\/api\/work-items$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { project_key, title, status, priority, description, tags } = body;
    if (!project_key || !title) {
      return err(res, 'project_key and title are required', 400);
    }

    const blPath = join(WORK, 'backlog.json');
    const bl = await readJson(blPath);

    const id = `W-${String(bl.next_id).padStart(3, '0')}`;
    bl.next_id++;

    const today = new Date().toISOString().slice(0, 10);
    const item = {
      id,
      title,
      status: status || 'open',
      priority: priority || 'medium',
      description: description || '',
      tags: tags || [],
      depends_on: [],
      created: today,
      updated: today,
      session_log: [],
    };

    if (!bl.projects[project_key]) {
      bl.projects[project_key] = { items: [] };
    }
    bl.projects[project_key].items.push(item);

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, item, 201);
  }],

  // Update work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'PATCH', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const allowed = ['title', 'status', 'priority', 'description', 'tags', 'depends_on'];

    const blPath = join(WORK, 'backlog.json');
    const bl = await readJson(blPath);

    let found = null;
    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      found = group.items.find(i => i.id === itemId);
      if (found) break;
    }

    if (!found) return err(res, 'work item not found', 404);

    const today = new Date().toISOString().slice(0, 10);
    for (const key of allowed) {
      if (key in body) found[key] = body[key];
    }
    found.updated = today;

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, found);
  }],

  // Delete work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const itemId = m[1];
    const blPath = join(WORK, 'backlog.json');
    const bl = await readJson(blPath);

    let found = false;
    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      const idx = group.items.findIndex(i => i.id === itemId);
      if (idx !== -1) {
        group.items.splice(idx, 1);
        found = true;
        break;
      }
    }

    if (!found) return err(res, 'work item not found', 404);

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, { deleted: itemId });
  }],

  // Add session log entry to work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/log$/, 'POST', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { message } = body;
    if (!message) return err(res, 'message is required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await readJson(blPath);

    let found = null;
    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      found = group.items.find(i => i.id === itemId);
      if (found) break;
    }

    if (!found) return err(res, 'work item not found', 404);

    const today = new Date().toISOString().slice(0, 10);
    if (!found.session_log) found.session_log = [];
    found.session_log.push({ date: today, summary: message });
    found.updated = today;

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, found);
  }],

  // Add dependencies to work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'POST', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { targets } = body;
    if (!targets || !targets.length) return err(res, 'targets array is required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    let found = null;
    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      found = group.items.find(i => i.id === itemId);
      if (found) break;
    }
    if (!found) return err(res, 'work item not found', 404);

    if (!found.depends_on) found.depends_on = [];
    const added = [];
    for (const tid of targets) {
      let targetExists = false;
      for (const group of Object.values(bl.projects)) {
        if (!group.items) continue;
        if (group.items.some(i => i.id === tid)) { targetExists = true; break; }
      }
      if (!targetExists) return err(res, `Target ${tid} not found`, 404);
      if (found.depends_on.includes(tid)) continue;
      if (detectCycle(itemId, tid, bl.projects)) {
        return err(res, `Circular dependency: ${itemId} → ${tid} would create a cycle`, 400);
      }
      found.depends_on.push(tid);
      added.push(tid);
    }

    const today = new Date().toISOString().slice(0, 10);
    found.updated = today;
    if (!found.session_log) found.session_log = [];
    if (added.length) found.session_log.push({ date: today, summary: `Added dependencies: ${added.join(', ')}` });

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, found);
  }],

  // Remove dependencies from work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'DELETE', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { targets } = body;
    if (!targets || !targets.length) return err(res, 'targets array is required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    let found = null;
    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      found = group.items.find(i => i.id === itemId);
      if (found) break;
    }
    if (!found) return err(res, 'work item not found', 404);

    if (!found.depends_on) found.depends_on = [];
    const removed = targets.filter(t => found.depends_on.includes(t));
    found.depends_on = found.depends_on.filter(d => !targets.includes(d));

    const today = new Date().toISOString().slice(0, 10);
    found.updated = today;
    if (!found.session_log) found.session_log = [];
    if (removed.length) found.session_log.push({ date: today, summary: `Removed dependencies: ${removed.join(', ')}` });

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, found);
  }],

  // --- Epic endpoints ---

  // List epics
  [/^\/api\/epics$/, 'GET', async (_m, _req, res) => {
    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);
    const epics = (bl.epics || []).map(epic => {
      const items = resolveEpicItems(epic, bl);
      const done = items.filter(i => i.status === 'done').length;
      return { ...epic, progress: { done, total: items.length } };
    });
    json(res, epics);
  }],

  // Get epic detail
  [/^\/api\/epics\/(E-\d+)$/, 'GET', async (m, _req, res) => {
    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);
    const epic = (bl.epics || []).find(e => e.id === m[1]);
    if (!epic) return err(res, 'epic not found', 404);
    const items = resolveEpicItems(epic, bl);
    const done = items.filter(i => i.status === 'done').length;
    json(res, { ...epic, resolved_items: items, progress: { done, total: items.length } });
  }],

  // Create epic
  [/^\/api\/epics$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { title, priority, description, acceptance_criteria, target_date, tags } = body;
    if (!title) return err(res, 'title is required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    const id = `E-${String(bl.next_epic_id).padStart(3, '0')}`;
    bl.next_epic_id++;

    const today = new Date().toISOString().slice(0, 10);
    const epic = {
      id,
      title,
      status: 'draft',
      priority: priority || 'medium',
      description: description || '',
      acceptance_criteria: acceptance_criteria || '',
      target_date: target_date || '',
      project_keys: Array.isArray(body.project_keys) ? body.project_keys : [],
      work_item_ids: [],
      tags: tags || [],
      created: today,
      updated: today,
      session_log: [{ date: today, summary: 'Created' }],
    };

    bl.epics.push(epic);
    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, epic, 201);
  }],

  // Update epic
  [/^\/api\/epics\/(E-\d+)$/, 'PATCH', async (m, req, res) => {
    const body = await parseBody(req);
    const allowed = ['title', 'status', 'priority', 'description', 'acceptance_criteria', 'target_date', 'tags', 'project_keys'];

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    const epic = (bl.epics || []).find(e => e.id === m[1]);
    if (!epic) return err(res, 'epic not found', 404);

    const today = new Date().toISOString().slice(0, 10);
    for (const key of allowed) {
      if (key in body) epic[key] = body[key];
    }
    epic.updated = today;

    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, epic);
  }],

  // Delete epic
  [/^\/api\/epics\/(E-\d+)$/, 'DELETE', async (m, _req, res) => {
    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    const idx = (bl.epics || []).findIndex(e => e.id === m[1]);
    if (idx === -1) return err(res, 'epic not found', 404);

    const epic = bl.epics[idx];
    for (const wid of epic.work_item_ids) {
      for (const group of Object.values(bl.projects)) {
        if (!group.items) continue;
        const item = group.items.find(i => i.id === wid);
        if (item && item.epic_id === epic.id) {
          item.epic_id = '';
          break;
        }
      }
    }

    bl.epics.splice(idx, 1);
    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, { deleted: m[1] });
  }],

  // Link work items to epic
  [/^\/api\/epics\/(E-\d+)\/link$/, 'POST', async (m, req, res) => {
    const body = await parseBody(req);
    const { work_item_ids } = body;
    if (!work_item_ids || !work_item_ids.length) return err(res, 'work_item_ids required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    const epic = (bl.epics || []).find(e => e.id === m[1]);
    if (!epic) return err(res, 'epic not found', 404);

    const today = new Date().toISOString().slice(0, 10);
    let linked = 0;
    for (const wid of work_item_ids) {
      let found = null;
      for (const group of Object.values(bl.projects)) {
        if (!group.items) continue;
        found = group.items.find(i => i.id === wid);
        if (found) break;
      }
      if (!found) continue;
      if (found.epic_id && found.epic_id !== epic.id) continue;
      found.epic_id = epic.id;
      if (!epic.work_item_ids.includes(wid)) epic.work_item_ids.push(wid);
      linked++;
    }

    recomputeProjectKeys(epic, bl);
    epic.updated = today;
    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, { linked, epic_id: epic.id });
  }],

  // Unlink work item from epic
  [/^\/api\/epics\/(E-\d+)\/unlink$/, 'POST', async (m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id } = body;
    if (!work_item_id) return err(res, 'work_item_id required', 400);

    const blPath = join(WORK, 'backlog.json');
    const bl = await migrateBacklog(await readJson(blPath), blPath);

    const epic = (bl.epics || []).find(e => e.id === m[1]);
    if (!epic) return err(res, 'epic not found', 404);

    const today = new Date().toISOString().slice(0, 10);
    epic.work_item_ids = epic.work_item_ids.filter(id => id !== work_item_id);

    for (const group of Object.values(bl.projects)) {
      if (!group.items) continue;
      const item = group.items.find(i => i.id === work_item_id);
      if (item && item.epic_id === epic.id) {
        item.epic_id = '';
        break;
      }
    }

    recomputeProjectKeys(epic, bl);
    epic.updated = today;
    await writeFile(blPath, JSON.stringify(bl, null, 2) + '\n');
    json(res, { unlinked: work_item_id, epic_id: epic.id });
  }],

  // Read epic plan
  [/^\/api\/epics\/(E-\d+)\/plan$/, 'GET', async (m, _req, res) => {
    try {
      const content = await readFile(join(WORK, 'epics', m[1], 'plan.md'), 'utf8');
      text(res, content);
    } catch {
      text(res, '', 'text/plain', 200);
    }
  }],

  // Write epic plan
  [/^\/api\/epics\/(E-\d+)\/plan$/, 'PUT', async (m, req, res) => {
    const body = await parseBody(req);
    const dir = join(WORK, 'epics', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), body.content || '');
    json(res, { saved: true });
  }],

  // Read epic doc
  [/^\/api\/epics\/(E-\d+)\/doc$/, 'GET', async (m, _req, res) => {
    try {
      const content = await readFile(join(WORK, 'epics', m[1], 'docs.md'), 'utf8');
      text(res, content);
    } catch {
      text(res, '', 'text/plain', 200);
    }
  }],

  // Write epic doc
  [/^\/api\/epics\/(E-\d+)\/doc$/, 'PUT', async (m, req, res) => {
    const body = await parseBody(req);
    const dir = join(WORK, 'epics', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'docs.md'), body.content || '');
    json(res, { saved: true });
  }],

  // Read work item plan
  [/^\/api\/work-items\/(W-\d+)\/plan$/, 'GET', async (m, _req, res) => {
    try {
      const content = await readFile(join(WORK, 'items', m[1], 'plan.md'), 'utf8');
      text(res, content);
    } catch {
      text(res, '', 'text/plain', 200);
    }
  }],

  // Write work item plan
  [/^\/api\/work-items\/(W-\d+)\/plan$/, 'PUT', async (m, req, res) => {
    const body = await parseBody(req);
    const dir = join(WORK, 'items', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plan.md'), body.content || '');
    json(res, { saved: true });
  }],

  // Read work item doc
  [/^\/api\/work-items\/(W-\d+)\/doc$/, 'GET', async (m, _req, res) => {
    try {
      const content = await readFile(join(WORK, 'items', m[1], 'docs.md'), 'utf8');
      text(res, content);
    } catch {
      text(res, '', 'text/plain', 200);
    }
  }],

  // Write work item doc
  [/^\/api\/work-items\/(W-\d+)\/doc$/, 'PUT', async (m, req, res) => {
    const body = await parseBody(req);
    const dir = join(WORK, 'items', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'docs.md'), body.content || '');
    json(res, { saved: true });
  }],

  // List work item artifacts
  [/^\/api\/work-items\/(W-\d+)\/artifacts$/, 'GET', async (m, _req, res) => {
    try {
      const files = await readdir(join(WORK, 'items', m[1]));
      json(res, { files });
    } catch {
      json(res, { files: [] });
    }
  }],

  // --- Onboard endpoint ---
  [/^\/api\/onboard$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { path: projectPath, organization } = body;
    if (!projectPath) return err(res, 'path is required', 400);

    const id = `D-${Date.now()}`;
    let prompt = `/onboard ${projectPath}`;
    if (organization) prompt += ` --organization ${organization}`;

    const dispatch = {
      id,
      work_item_id: null,
      epic_id: null,
      project_key: 'onboard',
      project_path: projectPath,
      title: `Onboard: ${projectPath.split('/').pop()}`,
      skip_permissions: false,
      status: 'running',
      output: [],
      lastLines: [],
      listeners: new Set(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    let proc;
    try {
      proc = spawn(CLAUDE_BIN, ['-p', '--output-format', 'stream-json', '--verbose'], {
        cwd: ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ARCHITECT_ROOT: ROOT },
      });
    } catch (err) {
      return json(res, { error: `Failed to spawn claude: ${err.message}` }, 500);
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    dispatch.process = proc;

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
            dispatch.session_id = evt.session_id;
            saveSessions();
          }
          if (evt.type === 'result' && evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveSessions();
          }
        } catch {}
        dispatch.output.push(line);
        for (const listener of dispatch.listeners) listener(line);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const line = JSON.stringify({ type: 'stderr', content: chunk.toString() });
      dispatch.output.push(line);
      for (const listener of dispatch.listeners) listener(line);
    });

    proc.on('close', (code) => {
      dispatch.status = code === 0 ? 'completed' : 'failed';
      dispatch.completed_at = new Date().toISOString();
      dispatch.process = null;
      for (const listener of dispatch.listeners) listener(null);
      dispatch.listeners.clear();
      saveSessions();
    });

    dispatches.set(id, dispatch);
    saveSessions();
    json(res, { dispatch_id: id, status: 'running' });
  }],

  // --- Dispatch endpoints ---

  // Create dispatch
  [/^\/api\/dispatch$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions } = body;

    if (!project_key) {
      return err(res, 'project_key is required', 400);
    }
    if (!work_item_id && !additional_instructions) {
      return err(res, 'work_item_id or additional_instructions is required', 400);
    }

    const projectPath = await resolveProjectPath(project_key);
    if (!projectPath) {
      return err(res, `Could not resolve path for project: ${project_key}`, 400);
    }

    const id = `D-${Date.now()}`;

    const [portfolio, workItem] = await Promise.all([
      loadPortfolioContext(project_key),
      work_item_id ? loadWorkItem(work_item_id, project_key) : null,
    ]);

    let epicContext = null;
    if (epic_id) {
      try {
        const bl = await readJson(join(WORK, 'backlog.json'));
        const epic = (bl.epics || []).find(e => e.id === epic_id);
        if (epic) {
          const items = resolveEpicItems(epic, bl);
          const done = items.filter(i => i.status === 'done').length;
          const planSnippet = await loadEpicPlanSnippet(epic_id);
          epicContext = {
            id: epic.id,
            title: epic.title,
            status: epic.status,
            progress: `${done}/${items.length}`,
            acceptance_criteria: epic.acceptance_criteria,
            items,
            plan_snippet: planSnippet,
          };
        }
      } catch {}
    }

    // Load related project contexts for epic dispatches
    let relatedProjects = null;
    if (epicContext && epicContext.items) {
      const relatedKeys = [...new Set(epicContext.items.map(i => i.project_key))].filter(k => k !== project_key);
      if (relatedKeys.length) {
        relatedProjects = (await Promise.all(
          relatedKeys.map(async k => {
            const ctx = await loadPortfolioContext(k);
            return ctx ? { key: k, entry: ctx.entry } : null;
          })
        )).filter(Boolean);
      }
    }

    const prompt = buildDispatchPrompt({
      workItem: workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null),
      projectKey: project_key,
      projectPath,
      additionalInstructions: additional_instructions,
      portfolio,
      epicContext,
      relatedProjects,
    });

    const dispatch = {
      id,
      work_item_id,
      epic_id: epic_id || null,
      project_key,
      project_path: projectPath,
      title: title || work_item_id || '',
      skip_permissions: !!skip_permissions,
      status: 'running',
      output: [],
      lastLines: [],
      listeners: new Set(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    let proc;
    try {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      if (skip_permissions) {
        args.push('--dangerously-skip-permissions');
      } else {
        args.push('--permission-mode', 'plan');
      }
      proc = spawn(CLAUDE_BIN, args, {
        cwd: projectPath,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ARCHITECT_ROOT: ROOT },
      });
    } catch (err) {
      return json(res, { error: `Failed to spawn claude: ${err.message}` }, 500);
    }

    proc.stdin.write(prompt);
    proc.stdin.end();

    dispatch.process = proc;

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        // Extract session_id and cost from stream events
        try {
          const evt = JSON.parse(line);
          if (evt.type === 'system' && evt.subtype === 'init' && evt.session_id) {
            dispatch.session_id = evt.session_id;
            saveSessions();
          }
          if (evt.type === 'result' && evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveSessions();
          }
          // Extract text for lastLines preview
          const text = extractStreamText(evt);
          if (text) {
            dispatch.lastLines.push(text);
            if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
          }
        } catch {}
        dispatch.output.push(line);
        for (const listener of dispatch.listeners) {
          listener(line);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const line = JSON.stringify({ type: 'stderr', content: chunk.toString() });
      dispatch.output.push(line);
      for (const listener of dispatch.listeners) {
        listener(line);
      }
    });

    proc.on('close', (code) => {
      dispatch.status = code === 0 ? 'completed' : 'failed';
      dispatch.completed_at = new Date().toISOString();
      dispatch.process = null;
      for (const listener of dispatch.listeners) {
        listener(null); // signal done
      }
      dispatch.listeners.clear();
      saveSessions();
    });

    dispatches.set(id, dispatch);
    saveSessions();
    json(res, { dispatch_id: id, status: 'running' });
  }],

  // Stream dispatch output (SSE)
  [/^\/api\/dispatch\/([A-Za-z0-9_-]+)\/stream$/, 'GET', async (m, _req, res) => {
    const dispatch = dispatches.get(m[1]);
    if (!dispatch) return err(res, 'dispatch not found');

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // Replay buffered output
    for (const line of dispatch.output) {
      res.write(`data: ${line}\n\n`);
    }

    if (dispatch.status !== 'running') {
      res.write(`event: done\ndata: ${JSON.stringify({ status: dispatch.status })}\n\n`);
      res.end();
      return;
    }

    // Listen for new events
    const listener = (line) => {
      if (line === null) {
        res.write(`event: done\ndata: ${JSON.stringify({ status: dispatch.status })}\n\n`);
        res.end();
      } else {
        res.write(`data: ${line}\n\n`);
      }
    };

    dispatch.listeners.add(listener);

    _req.on('close', () => {
      dispatch.listeners.delete(listener);
    });
  }],

  // List dispatches (returns all including completed/failed/interrupted)
  [/^\/api\/dispatch\/active$/, 'GET', async (_m, _req, res) => {
    const list = [];
    for (const [id, d] of dispatches) {
      list.push({
        id,
        work_item_id: d.work_item_id,
        epic_id: d.epic_id || null,
        project_key: d.project_key,
        project_path: d.project_path,
        status: d.status,
        session_id: d.session_id || null,
        cost_usd: d.cost_usd || null,
        started_at: d.started_at,
        completed_at: d.completed_at,
        last_output: d.lastLines || [],
        skip_permissions: d.skip_permissions || false,
      });
    }
    json(res, list);
  }],

  // Kill all dispatches (must be before :id route)
  [/^\/api\/dispatch\/all$/, 'DELETE', async (_m, _req, res) => {
    let killed = 0;
    for (const [id, dispatch] of dispatches) {
      if (dispatch.status !== 'running') continue;
      if (dispatch.process) {
        const timer = killProcessGraceful(dispatch.process);
        dispatch.process.on('close', () => clearTimeout(timer));
      }
      dispatch.status = 'killed';
      dispatch.completed_at = new Date().toISOString();
      for (const listener of dispatch.listeners) listener(null);
      dispatch.listeners.clear();
      killed++;
    }
    saveSessions();
    json(res, { killed });
  }],

  // Kill a dispatch
  [/^\/api\/dispatch\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const dispatch = dispatches.get(m[1]);
    if (!dispatch) return err(res, 'dispatch not found');
    if (dispatch.process) {
      const timer = killProcessGraceful(dispatch.process);
      dispatch.process.on('close', () => clearTimeout(timer));
    }
    dispatch.status = 'killed';
    dispatch.completed_at = new Date().toISOString();
    for (const listener of dispatch.listeners) listener(null);
    dispatch.listeners.clear();
    saveSessions();
    json(res, { status: 'killed', id: m[1] });
  }],

  // --- Terminal endpoints ---

  // Create terminal session
  [/^\/api\/terminal$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions } = body;

    if (!project_key) return err(res, 'project_key is required', 400);

    const projectPath = await resolveProjectPath(project_key);
    if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);

    const id = `T-${Date.now()}`;

    // Build prompt same as dispatch
    const [portfolio, workItem] = await Promise.all([
      loadPortfolioContext(project_key),
      work_item_id ? loadWorkItem(work_item_id, project_key) : null,
    ]);

    let epicContext = null;
    if (epic_id) {
      try {
        const bl = await readJson(join(WORK, 'backlog.json'));
        const epic = (bl.epics || []).find(e => e.id === epic_id);
        if (epic) {
          const items = resolveEpicItems(epic, bl);
          const done = items.filter(i => i.status === 'done').length;
          const planSnippet = await loadEpicPlanSnippet(epic_id);
          epicContext = {
            id: epic.id, title: epic.title, status: epic.status,
            progress: `${done}/${items.length}`,
            acceptance_criteria: epic.acceptance_criteria, items, plan_snippet: planSnippet,
          };
        }
      } catch {}
    }

    const prompt = buildDispatchPrompt({
      workItem: workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null),
      projectKey: project_key,
      projectPath,
      additionalInstructions: additional_instructions,
      portfolio,
      epicContext,
    });

    // Spawn interactive PTY with claude (use absolute path to avoid posix_spawnp PATH issues)
    let ptyProcess;
    try {
      const ptyArgs = skip_permissions ? ['--dangerously-skip-permissions'] : [];
      ptyProcess = pty.spawn(CLAUDE_BIN, ptyArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: projectPath,
        env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
      });
    } catch (err) {
      return json(res, { error: `Failed to spawn terminal: ${err.message}` }, 500);
    }

    const terminal = {
      id,
      type: 'claude',
      work_item_id: work_item_id || null,
      epic_id: epic_id || null,
      project_key,
      project_path: projectPath,
      title: title || additional_instructions?.slice(0, 60) || 'Interactive session',
      skip_permissions: !!skip_permissions,
      status: 'running',
      ptyProcess,
      scrollback: '',
      wsClients: new Set(),
      started_at: new Date().toISOString(),
      exited_at: null,
    };

    ptyProcess.onData((data) => {
      // Append to scrollback ring buffer
      terminal.scrollback += data;
      if (terminal.scrollback.length > SCROLLBACK_LIMIT) {
        terminal.scrollback = terminal.scrollback.slice(-SCROLLBACK_LIMIT);
      }
      // Send to all connected WebSocket clients
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'data', data })); } catch {}
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      terminal.status = exitCode === 0 ? 'completed' : 'failed';
      terminal.exited_at = new Date().toISOString();
      terminal.ptyProcess = null;
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'exit', code: exitCode })); } catch {}
      }
      saveSessions();
    });

    // After PTY is ready, write the prompt as first input
    setTimeout(() => {
      if (terminal.ptyProcess) {
        terminal.ptyProcess.write(prompt + '\r');
      }
    }, 500);

    terminals.set(id, terminal);
    saveSessions();
    json(res, { terminal_id: id, status: 'running' });
  }],

  // Spawn plain shell terminal (no Claude)
  [/^\/api\/terminal\/shell$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { project_key, work_item_id, epic_id, title } = body;

    if (!project_key) return err(res, 'project_key is required', 400);

    const projectPath = await resolveProjectPath(project_key);
    if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);

    const id = `T-${Date.now()}`;

    let ptyProcess;
    try {
      ptyProcess = pty.spawn(process.env.SHELL || '/bin/zsh', [], {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: projectPath,
        env: { ...process.env, TERM: 'xterm-256color' },
      });
    } catch (e) {
      return json(res, { error: `Failed to spawn shell: ${e.message}` }, 500);
    }

    const terminal = {
      id,
      type: 'shell',
      work_item_id: work_item_id || null,
      epic_id: epic_id || null,
      project_key,
      project_path: projectPath,
      title: title || 'Shell',
      skip_permissions: false,
      status: 'running',
      ptyProcess,
      scrollback: '',
      wsClients: new Set(),
      started_at: new Date().toISOString(),
      exited_at: null,
    };

    ptyProcess.onData((data) => {
      terminal.scrollback += data;
      if (terminal.scrollback.length > SCROLLBACK_LIMIT) {
        terminal.scrollback = terminal.scrollback.slice(-SCROLLBACK_LIMIT);
      }
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'data', data })); } catch {}
      }
    });

    ptyProcess.onExit(({ exitCode }) => {
      terminal.status = exitCode === 0 ? 'completed' : 'failed';
      terminal.exited_at = new Date().toISOString();
      terminal.ptyProcess = null;
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'exit', code: exitCode })); } catch {}
      }
      saveSessions();
    });

    terminals.set(id, terminal);
    saveSessions();
    json(res, { terminal_id: id, status: 'running' });
  }],

  // List active terminals
  [/^\/api\/terminal\/active$/, 'GET', async (_m, _req, res) => {
    const list = [];
    for (const [id, t] of terminals) {
      const scrollLines = t.scrollback ? t.scrollback.split('\n').filter(l => l.trim()).slice(-3) : [];
      list.push({
        id,
        type: t.type || 'claude',
        work_item_id: t.work_item_id,
        epic_id: t.epic_id || null,
        project_key: t.project_key,
        project_path: t.project_path,
        title: t.title,
        status: t.status,
        started_at: t.started_at,
        exited_at: t.exited_at,
        last_output: scrollLines,
        skip_permissions: t.skip_permissions || false,
      });
    }
    json(res, list);
  }],

  // Kill all terminals (must be before :id route)
  [/^\/api\/terminal\/all$/, 'DELETE', async (_m, _req, res) => {
    let killed = 0;
    for (const [, terminal] of terminals) {
      if (terminal.status !== 'running') continue;
      if (terminal.ptyProcess) {
        try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
      }
      terminal.status = 'killed';
      terminal.exited_at = new Date().toISOString();
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'exit', code: -1 })); ws.close(); } catch {}
      }
      terminal.wsClients.clear();
      killed++;
    }
    saveSessions();
    json(res, { killed });
  }],

  // Kill a terminal
  [/^\/api\/terminal\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const terminal = terminals.get(m[1]);
    if (!terminal) return err(res, 'terminal not found');
    if (terminal.ptyProcess) {
      try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
    }
    terminal.status = 'killed';
    terminal.exited_at = new Date().toISOString();
    for (const ws of terminal.wsClients) {
      try { ws.send(JSON.stringify({ type: 'exit', code: -1 })); ws.close(); } catch {}
    }
    terminal.wsClients.clear();
    saveSessions();
    json(res, { status: 'killed', id: m[1] });
  }],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  for (const [pattern, method, handler] of routes) {
    const match = path.match(pattern);
    if (match && req.method === method) {
      try {
        await handler(match, req, res);
      } catch (e) {
        err(res, e.code === 'ENOENT' ? 'not found' : e.message, e.code === 'ENOENT' ? 404 : 500);
      }
      return;
    }
  }
  err(res, 'not found');
});

// --- WebSocket server for terminal I/O ---
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://localhost');
  const match = url.pathname.match(/^\/api\/terminal\/([A-Za-z0-9_-]+)\/ws$/);
  if (!match) {
    socket.destroy();
    return;
  }
  const terminal = terminals.get(match[1]);
  if (!terminal) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Replay scrollback buffer
    if (terminal.scrollback) {
      ws.send(JSON.stringify({ type: 'data', data: terminal.scrollback }));
    }
    // If already exited, send exit event
    if (terminal.status !== 'running') {
      ws.send(JSON.stringify({ type: 'exit', code: 0 }));
    }

    terminal.wsClients.add(ws);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && terminal.ptyProcess) {
          terminal.ptyProcess.write(msg.data);
        } else if (msg.type === 'resize' && terminal.ptyProcess && msg.cols && msg.rows) {
          terminal.ptyProcess.resize(msg.cols, msg.rows);
        }
      } catch {}
    });

    ws.on('close', () => {
      terminal.wsClients.delete(ws);
    });
  });
});

// --- Auto-cleanup stale sessions ---
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, terminal] of terminals) {
    if (terminal.status !== 'running' && terminal.exited_at) {
      if (now - new Date(terminal.exited_at).getTime() > 10 * 60 * 1000) {
        terminals.delete(id);
        changed = true;
      }
    }
  }
  for (const [id, dispatch] of dispatches) {
    if (dispatch.status !== 'running' && dispatch.completed_at) {
      if (now - new Date(dispatch.completed_at).getTime() > 30 * 60 * 1000) {
        dispatches.delete(id);
        changed = true;
      }
    }
  }
  if (changed) saveSessions();
}, 60 * 1000);

server.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}`);
});
