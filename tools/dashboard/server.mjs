#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, rename, readdir, stat, mkdir, unlink as unlinkFile } from 'node:fs/promises';
import { createWriteStream, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, resolve, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import pty from 'node-pty';
import { WebSocketServer } from 'ws';
import * as db from './db.mjs';

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
const LOGS_DIR = join(WORK, 'logs');
const ARCHITECT_KEY = '\u2013/architect/\u2013';

const port = (() => {
  const idx = process.argv.indexOf('--port');
  if (idx !== -1 && process.argv[idx + 1]) return Number(process.argv[idx + 1]);
  if (process.env.PORT) return Number(process.env.PORT);
  return 3777;
})();

// Valid status values — canonical source: domain/entities.md
const VALID_WORK_ITEM_STATUSES = new Set(['open', 'in-progress', 'blocked', 'done', 'cancelled']);
const VALID_EPIC_STATUSES = new Set(['draft', 'active', 'done', 'cancelled', 'archived']);
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'critical']);

const SERVER_START_TIME = Date.now();
const DASHCTL_PATH = join(import.meta.dirname, 'dashctl.sh');
const PID_FILE = join(ROOT, 'tmp', 'dashboard.pid');
const LOG_FILE = join(ROOT, 'tmp', 'dashboard.log');

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

// --- Database initialization ---
const MIGRATIONS_DIR = join(import.meta.dirname, 'migrations');

// Session persistence helpers — write to SQLite per mutation
function saveDispatchToDb(d) {
  db.saveDispatch({
    id: d.id, work_item_id: d.work_item_id, epic_id: d.epic_id,
    project_key: d.project_key, project_path: d.project_path,
    title: d.title || d.work_item_id, permission_mode: d.permission_mode || 'acceptEdits',
    skip_permissions: d.skip_permissions || false,
    status: d.status, started_at: d.started_at, completed_at: d.completed_at,
    session_id: d.session_id || null, cost_usd: d.cost_usd || null,
    pid: d.pid || null,
  });
}

function saveTerminalToDb(t) {
  db.saveTerminal({
    id: t.id, type: t.type || 'claude', work_item_id: t.work_item_id, epic_id: t.epic_id,
    project_key: t.project_key, project_path: t.project_path,
    title: t.title, permission_mode: t.permission_mode || 'acceptEdits',
    skip_permissions: t.skip_permissions || false,
    status: t.status, started_at: t.started_at, exited_at: t.exited_at,
    pid: t.pid || null, tmux_session: t.tmux_session || null,
  });
}

function saveCliSessionToDb(c) {
  db.saveCliSession({
    id: c.id, project_key: c.project_key, work_item_id: c.work_item_id,
    epic_id: c.epic_id, title: c.title, pid: c.pid,
    status: c.status, registered_at: c.registered_at, exited_at: c.exited_at,
  });
}

// --- PID liveness check ---
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// --- Project sync from portfolio registry ---
function syncProjectsFromRegistry() {
  const registryPath = join(PORTFOLIO, 'registry.json');
  if (!existsSync(registryPath)) return 0;
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  let count = 0;
  for (const [path, entry] of Object.entries(registry.entries || {})) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    let role = '';
    try {
      const comp = JSON.parse(readFileSync(join(PORTFOLIO, entry.org, entry.project, `${entry.component}.json`), 'utf8'));
      role = comp.role || '';
    } catch {}
    db.upsertProject({ key, org: entry.org, project: entry.project, component: entry.component, path, role });
    count++;
  }
  if (count) console.log(`Synced ${count} projects from portfolio registry`);
  return count;
}

// --- Archive session to permanent history ---
function archiveSession(session, type) {
  const endedAt = type === 'cli' ? session.exited_at : (type === 'dispatch' ? session.completed_at : session.exited_at);
  const startedAt = type === 'cli' ? session.registered_at : session.started_at;
  if (!endedAt || !startedAt || !session.project_key) return;
  try {
    db.recordSessionHistory({
      id: session.id, type, project_key: session.project_key,
      work_item_id: session.work_item_id, epic_id: session.epic_id,
      title: session.title || '', status: session.status,
      permission_mode: session.permission_mode,
      started_at: startedAt, ended_at: endedAt, cost_usd: session.cost_usd || null,
    });
  } catch (e) {
    console.error(`Failed to archive ${type} ${session.id}:`, e.message);
  }
}

// --- Dispatch registry ---
const dispatches = new Map();

// --- Terminal registry ---
const terminals = new Map();
const SCROLLBACK_LIMIT = 100 * 1024; // 100KB ring buffer

// --- CLI session registry ---
const cliSessions = new Map();

// tmux helpers
const TMUX_AVAILABLE = (() => {
  try {
    execFileSync('which', ['tmux'], { encoding: 'utf8' });
    return true;
  } catch { return false; }
})();

function tmuxSessionExists(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function captureTmuxScrollback(name) {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', name, '-p', '-e', '-S', '-1000'], { encoding: 'utf8' });
  } catch { return ''; }
}

// Shared terminal handler wiring (used for fresh spawn and restore)
function wireTerminalHandlers(terminal) {
  terminal.ptyProcess.onData((data) => {
    terminal.scrollback += data;
    if (terminal.scrollback.length > SCROLLBACK_LIMIT) {
      const sliced = terminal.scrollback.slice(-SCROLLBACK_LIMIT);
      const firstNewline = sliced.indexOf('\n');
      terminal.scrollback = firstNewline > 0 ? sliced.slice(firstNewline + 1) : sliced;
    }
    // Persist to disk for restart recovery
    if (terminal.logStream) {
      try { terminal.logStream.write(data); } catch {}
    }
    for (const ws of terminal.wsClients) {
      try { ws.send(JSON.stringify({ type: 'data', data })); } catch {}
    }
  });

  terminal.ptyProcess.onExit(({ exitCode }) => {
    terminal.status = exitCode === 0 ? 'completed' : 'failed';
    terminal.exited_at = new Date().toISOString();
    terminal.ptyProcess = null;
    if (terminal.logStream) { terminal.logStream.end(); terminal.logStream = null; }
    if (terminal.tmux_session) {
      try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
    }
    for (const ws of terminal.wsClients) {
      try { ws.send(JSON.stringify({ type: 'exit', code: exitCode })); ws.close(); } catch {}
    }
    terminal.wsClients.clear();
    archiveSession(terminal, 'terminal');
    saveTerminalToDb(terminal);
    // Keep terminal in memory for frontend display; auto-cleanup timer handles removal after 10min
  });
}

// Tail a log file for a reconnected dispatch (PID alive but no process handle)
function tailLogFile(dispatch) {
  let offset = 0;
  // Read existing lines for initial offset
  try {
    const content = readFileSync(dispatch.logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    offset = lines.length;
    // Populate output buffer from existing log
    dispatch.output = lines;
    // Populate lastLines preview
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        const text = extractStreamText(evt);
        if (text) {
          dispatch.lastLines.push(text);
          if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
        }
      } catch {}
    }
  } catch {}

  // Re-open log stream for any new output written by the orphaned process
  try {
    dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });
  } catch {}

  const interval = setInterval(() => {
    if (!dispatch.pid || !isPidAlive(dispatch.pid)) {
      clearInterval(interval);
      dispatch._tailInterval = null;
      dispatch.status = 'interrupted';
      dispatch.completed_at = new Date().toISOString();
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      saveDispatchToDb(dispatch);
      for (const listener of dispatch.listeners) listener(null);
      dispatch.listeners.clear();
      return;
    }
    try {
      const content = readFileSync(dispatch.logPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const newLines = lines.slice(offset);
      offset = lines.length;
      for (const line of newLines) {
        dispatch.output.push(line);
        try {
          const evt = JSON.parse(line);
          const text = extractStreamText(evt);
          if (text) {
            dispatch.lastLines.push(text);
            if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
          }
          if (evt.type === 'result' && evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveDispatchToDb(dispatch);
          }
        } catch {}
        for (const listener of dispatch.listeners) listener(line);
      }
    } catch {}
  }, 2000);
  dispatch._tailInterval = interval;
}

// Restore persisted sessions from SQLite with PID liveness checks
function restoreSessions() {
  // Mark legacy rows (no PID) as interrupted
  db.markRunningAsInterrupted();

  const now = new Date().toISOString();
  let reconnectedDispatches = 0;
  let interruptedDispatches = 0;
  let reconnectedTerminals = 0;
  let interruptedTerminals = 0;

  for (const d of db.getPersistedDispatches()) {
    if (d.status === 'running' && d.pid) {
      if (isPidAlive(d.pid)) {
        // Process survived restart — reconnect via log file tailing
        reconnectedDispatches++;
        const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
        const dispatch = {
          ...d,
          output: [],
          lastLines: [],
          listeners: new Set(),
          process: null,
          logPath,
          logStream: null,
        };
        dispatches.set(d.id, dispatch);
        tailLogFile(dispatch);
        console.log(`Dispatch ${d.id}: PID ${d.pid} still alive, reconnecting via log tail`);
      } else {
        // PID dead — mark interrupted
        interruptedDispatches++;
        d.status = 'interrupted';
        d.completed_at = now;
        db.updateDispatchStatus(d.id, 'interrupted', now);
        archiveSession(d, 'dispatch');
        dispatches.set(d.id, {
          ...d, output: [], lastLines: [], listeners: new Set(), process: null,
        });
      }
    } else {
      // Non-running dispatch (completed/failed/killed/interrupted) — archive then clean up
      archiveSession(d, 'dispatch');
      db.deleteDispatch(d.id);
      unlinkFile(join(LOGS_DIR, `${d.id}.jsonl`)).catch(() => {});
    }
  }

  for (const t of db.getPersistedTerminals()) {
    if (t.status === 'running') {
      if (t.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(t.tmux_session)) {
        // Re-attach to tmux session
        reconnectedTerminals++;
        try {
          const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', t.tmux_session], {
            name: 'xterm-256color', cols: 80, rows: 24,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
          // Prefer persisted log file over tmux capture (more complete, preserves escape sequences)
          const logPath = join(LOGS_DIR, `${t.id}.raw`);
          let scrollback = '';
          try {
            scrollback = readFileSync(logPath, 'utf8');
            if (scrollback.length > SCROLLBACK_LIMIT) {
              const sliced = scrollback.slice(-SCROLLBACK_LIMIT);
              const firstNewline = sliced.indexOf('\n');
              scrollback = firstNewline > 0 ? sliced.slice(firstNewline + 1) : sliced;
            }
          } catch {
            scrollback = captureTmuxScrollback(t.tmux_session);
          }
          const terminal = {
            ...t,
            ptyProcess,
            scrollback,
            logStream: createWriteStream(logPath, { flags: 'a' }),
            wsClients: new Set(),
          };
          wireTerminalHandlers(terminal);
          terminals.set(t.id, terminal);
          console.log(`Terminal ${t.id}: tmux session ${t.tmux_session} re-attached`);
        } catch (e) {
          // tmux attach failed — mark interrupted
          interruptedTerminals++;
          t.status = 'interrupted';
          t.exited_at = now;
          db.updateTerminalStatus(t.id, 'interrupted', now);
          archiveSession(t, 'terminal');
          terminals.set(t.id, { ...t, ptyProcess: null, scrollback: '', wsClients: new Set() });
        }
      } else if (t.pid && isPidAlive(t.pid)) {
        // PID alive but no tmux — alive but detached
        reconnectedTerminals++;
        terminals.set(t.id, {
          ...t, ptyProcess: null, scrollback: '', wsClients: new Set(),
          alive_but_detached: true,
        });
        console.log(`Terminal ${t.id}: PID ${t.pid} alive but no tmux — marked as detached`);
      } else {
        // Dead
        interruptedTerminals++;
        t.status = 'interrupted';
        t.exited_at = now;
        db.updateTerminalStatus(t.id, 'interrupted', now);
        archiveSession(t, 'terminal');
        terminals.set(t.id, { ...t, ptyProcess: null, scrollback: '', wsClients: new Set() });
      }
    } else {
      // Non-running terminal — archive then clean up
      archiveSession(t, 'terminal');
      db.deleteTerminal(t.id);
      unlinkFile(join(LOGS_DIR, `${t.id}.raw`)).catch(() => {});
    }
  }

  for (const c of db.getPersistedCliSessions()) {
    if (c.status === 'running' && isPidAlive(c.pid)) {
      cliSessions.set(c.id, { ...c });
    } else {
      // Dead or exited CLI session — archive then clean up
      if (!c.exited_at) c.exited_at = now;
      archiveSession(c, 'cli');
      db.deleteCliSession(c.id);
    }
  }

  if (dispatches.size || terminals.size || cliSessions.size) {
    console.log(`Restored: ${dispatches.size} dispatches (${reconnectedDispatches} reconnected, ${interruptedDispatches} interrupted), ${terminals.size} terminals (${reconnectedTerminals} reconnected, ${interruptedTerminals} interrupted), ${cliSessions.size} CLI sessions`);
  }
  if (!TMUX_AVAILABLE) {
    console.log('Note: tmux not found — terminal sessions will not survive restarts. Install with: brew install tmux');
  }
}

function extractStreamText(evt) {
  if (evt.type === 'assistant' && evt.message?.content) {
    return evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (evt.type === 'content_block_delta' && evt.delta?.text) return evt.delta.text;
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') return `▸ ${evt.content_block.name || 'tool'}`;
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

// Shared dispatch process wiring: stdout/stderr parsing, log file writing, close handler
function wireDispatchHandlers(dispatch, proc) {
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
          saveDispatchToDb(dispatch);
        }
        if (evt.type === 'result' && evt.total_cost_usd != null) {
          dispatch.cost_usd = evt.total_cost_usd;
          dispatch.needs_input = false;
          saveDispatchToDb(dispatch);
        }
        // Track needs_input: agent asked a question (end_turn) vs using tools (tool_use)
        if (evt.type === 'assistant' && evt.message?.stop_reason === 'end_turn') {
          dispatch.needs_input = true;
        } else if (evt.type === 'assistant' && evt.message?.stop_reason === 'tool_use') {
          dispatch.needs_input = false;
        }
        const text = extractStreamText(evt);
        if (text) {
          dispatch.lastLines.push(text);
          if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
        }
      } catch {}
      dispatch.output.push(line);
      if (dispatch.logStream) dispatch.logStream.write(line + '\n');
      for (const listener of dispatch.listeners) listener(line);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = JSON.stringify({ type: 'stderr', content: chunk.toString() });
    dispatch.output.push(line);
    if (dispatch.logStream) dispatch.logStream.write(line + '\n');
    for (const listener of dispatch.listeners) listener(line);
  });

  proc.on('close', (code) => {
    dispatch.status = code === 0 ? 'completed' : 'failed';
    dispatch.completed_at = new Date().toISOString();
    dispatch.process = null;
    if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
    if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
    for (const listener of dispatch.listeners) listener(null);
    dispatch.listeners.clear();
    archiveSession(dispatch, 'dispatch');
    saveDispatchToDb(dispatch);
    // Keep dispatch in memory for frontend display; auto-cleanup timer handles removal after 30min
  });
}

async function resolveProjectPath(projectKey) {
  if (projectKey === ARCHITECT_KEY) return ROOT;
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
  if (!entry && !orgData) return null;

  // Load portfolio guide markdown files from disk
  let guides = null;
  if (entry?.portfolio_guides?.length) {
    const guideDir = join(PORTFOLIO, org, project);
    guides = (await Promise.all(
      entry.portfolio_guides.map(async filename => {
        try {
          const content = await readFile(join(guideDir, filename), 'utf8');
          return { filename, content };
        } catch { return null; }
      })
    )).filter(Boolean);
    if (!guides.length) guides = null;
  }

  return { entry, org: orgData, guides };
}

function loadWorkItem(workItemId) {
  return db.getWorkItemFull(workItemId);
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


async function loadEpicPlanSnippet(epicId) {
  try {
    const content = await readFile(join(WORK, 'epics', epicId, 'plan.md'), 'utf8');
    return content.slice(0, 500);
  } catch {
    return '';
  }
}

async function selectAgentsForDispatch({ workItem, portfolio }) {
  const always = ['pm', 'scout', 'planner', 'coder', 'tester', 'reviewer'];
  const conditional = {
    'coder-frontend': /front.?end|ui|css|react|vue|angular|svelte|html|component|layout|responsive|tailwind/i,
    'coder-backend': /back.?end|api|server|endpoint|database|graphql|rest|middleware|auth/i,
    'coder-infra': /infra|docker|k8s|kubernetes|terraform|ci.?cd|deploy|devops|aws|gcp|azure|pipeline/i,
    'coder-mobile': /mobile|ios|android|flutter|react.native|swift|kotlin/i,
    'security-auditor': /secur|auth|token|secret|credential|permission|access.?control|encrypt|vulnerab/i,
    'refactorer': /refactor|restructur|reorganiz|clean.?up|technical.?debt|migration/i,
    'debugger': /bug|debug|fix|crash|error|broken|regression|investig|diagnos/i,
    'documenter': /document|readme|changelog|api.?doc|jsdoc|typedoc/i,
    'ci-cd': /ci.?cd|pipeline|github.?action|deploy|release|build.?system/i,
  };

  // Build search text from work item + stack
  const textParts = [];
  if (workItem) {
    textParts.push(workItem.title || '', workItem.description || '', (workItem.tags || []).join(' '));
  }
  if (portfolio?.entry?.guidance?.stack_summary) textParts.push(portfolio.entry.guidance.stack_summary);
  const searchText = textParts.join(' ');

  const selected = [...always];
  for (const [agent, pattern] of Object.entries(conditional)) {
    if (pattern.test(searchText)) selected.push(agent);
  }

  // Cap at 10
  const capped = selected.slice(0, 10);

  // Read agent .md files, strip frontmatter, build --agents JSON
  const agents = [];
  for (const name of capped) {
    try {
      let content = await readFile(join(ROOT, '.claude', 'agents', `${name}.md`), 'utf8');
      // Strip YAML frontmatter
      if (content.startsWith('---')) {
        const endIdx = content.indexOf('---', 3);
        if (endIdx !== -1) content = content.slice(endIdx + 3).trim();
      }
      agents.push({ name, prompt: content });
    } catch {
      // Agent file not found, skip
    }
  }
  return agents;
}

function buildDispatchPrompt({ workItem, projectKey, projectPath, additionalInstructions, portfolio, epicContext, relatedProjects }) {
  const sections = [];

  // --- Identity ---
  sections.push([
    '# Identity',
    '',
    'You are an **architect SDLC agent** — a full software development lifecycle orchestrator, not a simple task worker.',
    '',
    '**Responsibilities**:',
    '- Triage the assigned work item: assess complexity, identify risks, select the right workflow',
    '- Plan before implementing — do not jump straight to code for non-trivial work',
    '- Dispatch specialized sub-agents (pm, planner, tester, reviewer, etc.) as needed',
    '- Track progress via the dashboard API',
    '- Be critical — if the work item is vague or the approach seems suboptimal, document your assessment and propose alternatives before implementing',
    '',
    'You are not limited to writing code. You can perform planning, architecture review, security audit, testing strategy, documentation, and project management.',
  ].join('\n'));

  // --- SDLC Guide ---
  sections.push([
    '# SDLC Guide',
    '',
    '## Workflow Selection',
    '',
    '| Condition | Workflow |',
    '|-----------|----------|',
    '| Trivial tasks | direct — dispatch a single coder agent |',
    '| Small features | sequential — scout → planner → coder → tester → reviewer |',
    '| Full-stack work (independent FE/BE/infra) | parallel-fan-out — split then converge at tester → reviewer |',
    '| Medium/large features | plan-then-execute — planner decomposes, then dispatch coders per task |',
    '| Bugfixes | investigate-then-fix — debugger/scout → coder → tester |',
    '| Vague scope, strategic decisions | strategic-evaluation — strategist evaluates first |',
    '',
    '## Agent Inclusion Rules',
    '',
    '| Agent | Include when |',
    '|-------|-------------|',
    '| scout | No portfolio entry exists for the target project |',
    '| strategist | Large/vague/strategic requests, build-vs-buy decisions |',
    '| planner | Medium+ complexity (skip for small/trivial) |',
    '| tester | All code changes except trivial |',
    '| reviewer | All code changes except trivial |',
    '| security-auditor | Auth, secrets, input validation, or external data involved |',
    '',
    '## Coordination Rules',
    '',
    '- You act as the orchestrator. Dispatch sub-agents using the Agent tool.',
    '- Sub-agents cannot spawn their own sub-agents — only you orchestrate.',
    '- Read-only agents (reviewer, security-auditor, scout, debugger, pm, strategist) do not modify code.',
    '- Implementation agents (coder, coder-frontend, coder-backend, coder-infra, coder-mobile) modify code.',
    '- Run scout or load portfolio context before dispatching implementation agents on a new project.',
    '- Use parallel fan-out when tasks are independent; sequential pipeline when output feeds the next step.',
    '- When dispatching sub-agents, include the Coding Standards block from this prompt in the Agent tool\'s prompt parameter. Sub-agents do not inherit it automatically.',
    '',
    '## Process for Any Work Item',
    '',
    '1. Assess complexity (trivial / small / medium / large / strategic)',
    '2. Select workflow from the table above',
    '3. Plan if needed (medium+ complexity)',
    '4. Dispatch agents per the workflow',
    '5. Test (dispatch tester for all non-trivial code changes)',
    '6. Review (dispatch reviewer)',
    '7. Log results via the dashboard API',
  ].join('\n'));

  // --- Available Skills ---
  sections.push([
    '# Available Skills',
    '',
    'These workflows can be followed by reading use-case files from `$ARCHITECT_ROOT/usecases/`:',
    '',
    '| Command | Purpose |',
    '|---------|---------|',
    '| /onboard | Scan and register project in portfolio |',
    '| /portfolio | View and manage project portfolio |',
    '| /scaffold | Create new project from template |',
    '| /review | Comprehensive code review |',
    '| /test | Run and generate tests |',
    '| /deploy | Local deployment |',
    '| /pr | Create PR with review summary |',
    '| /diagnose | Debug an issue |',
    '| /secure | Security audit |',
    '| /status | Project health check |',
    '| /work | Track work items across sessions |',
    '| /migrate | Technology migration |',
    '| /explain | Codebase walkthrough |',
    '| /release | Version bump, changelog, git tag |',
    '| /refactor | Systematic refactoring |',
    '| /browse | Web automation via browser agent |',
    '| /worktree | Manage git worktrees |',
  ].join('\n'));

  // --- Scope ---
  const scopeLines = ['# Scope', ''];
  const org = projectKey.split('/')[0];
  if (org && org !== '–') scopeLines.push(`- **Organization**: ${org}`);
  scopeLines.push(`- **Project**: ${projectKey}`);
  if (workItem) scopeLines.push(`- **Work Item**: ${workItem.id}`);
  if (epicContext) scopeLines.push(`- **Epic**: ${epicContext.id}`);
  sections.push(scopeLines.join('\n'));

  // --- Architect System (awareness section) ---
  {
    const awareLines = ['# Architect System', ''];
    awareLines.push('You are managed by the **architect SDLC system**. Your project has a knowledge base in the architect portfolio.');
    awareLines.push('');
    const [pOrg, pProject, pComponent] = (projectKey || '').split('/');
    if (pOrg && pProject && pComponent) {
      awareLines.push(`- **Portfolio entry**: \`$ARCHITECT_ROOT/portfolio/${pOrg}/${pProject}/${pComponent}.json\``);
      if (portfolio?.guides?.length) {
        awareLines.push(`- **Portfolio guides**: ${portfolio.guides.map(g => g.filename).join(', ')} (in \`$ARCHITECT_ROOT/portfolio/${pOrg}/${pProject}/\`)`);
      }
    }
    awareLines.push(`- **Domain rules**: \`$ARCHITECT_ROOT/domain/rules.md\` — business rules and constraints`);
    awareLines.push(`- **Entity schemas**: \`$ARCHITECT_ROOT/domain/entities.md\``);
    awareLines.push(`- **Use-case workflows**: \`$ARCHITECT_ROOT/usecases/\``);
    awareLines.push('');
    awareLines.push('When you need deeper context about the project, read from the portfolio entry or guides. For cross-project context, query the dashboard API.');
    sections.push(awareLines.join('\n'));
  }

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
    if (e.brief?.key_entities?.length) lines.push(`**Key Entities**: ${e.brief.key_entities.join(', ')}`);
    if (e.brief?.data_flow) lines.push(`**Data Flow**: ${e.brief.data_flow}`);
    if (e.brief?.architecture_rationale) lines.push(`**Architecture Rationale**: ${e.brief.architecture_rationale}`);
    if (e.brief?.constraints?.length) {
      lines.push('', '**Constraints**:');
      for (const c of e.brief.constraints) lines.push(`- ${c}`);
    }
    if (e.brief?.environments?.length) {
      lines.push('', '**Environments**:');
      for (const env of e.brief.environments) lines.push(`- ${env}`);
    }
    if (e.brief?.external_dependencies?.length) {
      lines.push('', '**External Dependencies**:');
      for (const dep of e.brief.external_dependencies) lines.push(`- ${dep}`);
    }
    if (e.guidance?.ci_cd?.length) {
      lines.push('', '**CI/CD**:');
      for (const c of e.guidance.ci_cd) lines.push(`- ${c}`);
    }
    if (e.guidance?.testing?.length) {
      lines.push('', '**Testing**:');
      for (const t of e.guidance.testing) lines.push(`- ${t}`);
    }
    if (e.custom_rules?.length) {
      lines.push('', '**Project Rules**:');
      for (const r of e.custom_rules) lines.push(`- ${r}`);
    }
    if (e.doc_paths?.length) {
      lines.push('', '**Documentation** (files in target project):');
      for (const d of e.doc_paths) lines.push(`- ${d}`);
    }
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

  // --- Portfolio Guides (deep project knowledge from markdown files) ---
  if (portfolio?.guides?.length) {
    const guideLines = ['# Portfolio Guides', '',
      'Deep project knowledge from the architect portfolio. Follow these when relevant to your task.', ''];
    let totalLen = 0;
    const MAX_GUIDE_CHARS = 20000;
    const [pOrg, pProject] = (projectKey || '').split('/');
    for (const g of portfolio.guides) {
      if (totalLen + g.content.length > MAX_GUIDE_CHARS) {
        guideLines.push(`## ${g.filename}`, '',
          `(truncated — read full file at \`$ARCHITECT_ROOT/portfolio/${pOrg}/${pProject}/${g.filename}\`)`, '',
          g.content.slice(0, MAX_GUIDE_CHARS - totalLen), '');
        break;
      }
      guideLines.push(`## ${g.filename}`, '', g.content, '');
      totalLen += g.content.length;
    }
    sections.push(guideLines.join('\n'));
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

  // --- Coding Standards (inline brief — self-contained, no file read required) ---
  sections.push([
    '# Coding Standards',
    '',
    'Read `domain/rules.md` → Coding Standards for full details. Key principles:',
    '- **Domain-First**: Before defining types, enums, or state values, check the domain layer for existing canonical definitions. Import, do not redefine.',
    '- **DRY**: Three occurrences = extract. Single source of truth for all shared definitions.',
    '- **Clean Architecture**: Dependencies point inward. Separate business logic from I/O and frameworks.',
    '- **Clean Code**: Short single-purpose functions. Self-explanatory names. No commented-out code.',
    '',
    'CODING STANDARDS — apply to all code you write:',
    '- Names reveal intent: `userCount` not `n`, `isAuthenticated` not `flag`, `fetchOrderHistory()` not `getData()`',
    '- No comments except TODO/DECISION tags — if code needs a comment, rename or restructure',
    '- No dead code: no commented-out code, no unused imports, no unreachable branches',
    '- Functions: single-purpose, ~20 lines max. If description has "and", split it',
    '- Dependencies point inward: domain ← usecases ← adapters ← infrastructure. Never import outward.',
    '- Business logic must not contain I/O (HTTP, DB, file, UI). Use dependency injection or ports/adapters.',
    '- Domain layer owns all types, enums, state values. Other layers import — never redefine.',
    '- Before creating any type/enum/constant, search the domain layer first. Import if it exists.',
    '- Three occurrences = extract to shared utility. Single source of truth — never redefine values.',
    '- No over-engineering: no abstractions without two concrete use cases.',
    '- Integrate through existing interfaces — do not bypass layers or create parallel paths.',
    '- Avoid OWASP Top 10 vulnerabilities. Consider Linux compatibility.',
    '',
    '**Sub-agent propagation**: When you dispatch sub-agents via the Agent tool, include the above coding standards block in the prompt parameter. Sub-agents do not automatically inherit these standards.',
  ].join('\n'));

  // --- Environment (always included) ---
  {
    const envLines = ['# Environment', ''];
    envLines.push(`You are running in the target project directory: ${projectPath || '(unknown)'}`);
    envLines.push(`The architect project (portfolio, backlog, domain rules) is at: ${ROOT}`);
    envLines.push(`- Backlog: SQLite at ${ROOT}/work/architect.db (use dashboard API)`);
    envLines.push(`- Dashboard API: http://127.0.0.1:${port}`);
    envLines.push('');
    envLines.push('Use the architect project to look up cross-project context, related tasks, domain rules, or use-case workflows when needed. Your primary work should happen in the current directory (the target project).');
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
    trackLines.push('- Focus primarily on this work item\'s goals. If you discover adjacent work, log it as a new backlog item via the dashboard API rather than expanding scope silently.');
    trackLines.push('- Be critical about the approach — if the work item description is vague or the approach seems suboptimal, document your assessment and propose alternatives before implementing.');
    trackLines.push(`- To create a new work item for adjacent work discovered:`);
    trackLines.push(`  curl -s -X POST http://127.0.0.1:${port}/api/work-items \\`);
    trackLines.push(`    -H 'Content-Type: application/json' -d '{"project_key": "${projectKey}", "title": "...", "description": "...", "priority": "medium", "tags": []}'`);
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

  // Open PRs for a project (runs gh CLI in the project directory)
  [/^\/api\/project\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)\/prs$/, 'GET', async (m, _req, res) => {
    const projectKey = `${m[1]}/${m[2]}/${m[3]}`;
    const projectPath = await resolveProjectPath(projectKey);
    if (!projectPath) return json(res, []);
    try {
      const result = execFileSync('gh', [
        'pr', 'list', '--json', 'number,title,url,headRefName,author', '--state', 'open',
      ], { cwd: projectPath, encoding: 'utf8', timeout: 15000 });
      json(res, JSON.parse(result));
    } catch {
      json(res, []);
    }
  }],

  // Backlog
  [/^\/api\/backlog$/, 'GET', async (_m, req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const orgFilter = reqUrl.searchParams.get('org');
    json(res, db.getBacklog(orgFilter || null));
  }],

  // Next available IDs (peek without incrementing)
  [/^\/api\/sequences\/next$/, 'GET', async (_m, _req, res) => {
    json(res, db.peekNextIds());
  }],

  // --- Work item endpoints ---

  // Get single work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'GET', async (m, _req, res) => {
    const item = db.getWorkItemFull(m[1]);
    if (!item) return err(res, 'work item not found', 404);
    json(res, item);
  }],

  // Create work item
  [/^\/api\/work-items$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { project_key, title, status, priority, description, tags, epic_id } = body;
    if (!project_key || !title) {
      return err(res, 'project_key and title are required', 400);
    }
    if (status && !VALID_WORK_ITEM_STATUSES.has(status)) {
      return err(res, `invalid status '${status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
    }
    if (priority && !VALID_PRIORITIES.has(priority)) {
      return err(res, `invalid priority '${priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
    }
    const item = db.createWorkItem({ project_key, title, status, priority, description, tags, epic_id });
    json(res, item, 201);
  }],

  // Update work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'PATCH', async (m, req, res) => {
    const itemId = m[1];
    const existing = db.getWorkItem(itemId);
    if (!existing) return err(res, 'work item not found', 404);
    const body = await parseBody(req);
    if (body.status && !VALID_WORK_ITEM_STATUSES.has(body.status)) {
      return err(res, `invalid status '${body.status}', must be one of: ${[...VALID_WORK_ITEM_STATUSES].join(', ')}`, 400);
    }
    if (body.priority && !VALID_PRIORITIES.has(body.priority)) {
      return err(res, `invalid priority '${body.priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
    }
    const updated = db.updateWorkItem(itemId, body);
    json(res, updated);
  }],

  // Delete work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const deleted = db.deleteWorkItem(m[1]);
    if (!deleted) return err(res, 'work item not found', 404);
    json(res, { deleted: m[1] });
  }],

  // Add session log entry to work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/log$/, 'POST', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { message, summary } = body;
    const logMsg = message || summary;
    if (!logMsg) return err(res, 'message is required', 400);
    const existing = db.getWorkItem(itemId);
    if (!existing) return err(res, 'work item not found', 404);
    db.addWorkItemLog(itemId, logMsg);
    json(res, db.getWorkItemFull(itemId));
  }],

  // Add dependencies to work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'POST', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { targets } = body;
    if (!targets || !targets.length) return err(res, 'targets array is required', 400);

    const added = [];
    for (const tid of targets) {
      try {
        db.addDependency(itemId, tid);
        added.push(tid);
      } catch (e) {
        return err(res, e.message, 400);
      }
    }
    if (added.length) db.addWorkItemLog(itemId, `Added dependencies: ${added.join(', ')}`);
    json(res, db.getWorkItemFull(itemId));
  }],

  // Remove dependencies from work item
  [/^\/api\/work-items\/([A-Za-z0-9_-]+)\/depend$/, 'DELETE', async (m, req, res) => {
    const itemId = m[1];
    const body = await parseBody(req);
    const { targets } = body;
    if (!targets || !targets.length) return err(res, 'targets array is required', 400);

    const existing = db.getWorkItem(itemId);
    if (!existing) return err(res, 'work item not found', 404);

    const removed = targets.filter(t => existing.depends_on.includes(t));
    for (const tid of removed) {
      db.removeDependency(itemId, tid);
    }
    if (removed.length) db.addWorkItemLog(itemId, `Removed dependencies: ${removed.join(', ')}`);
    json(res, db.getWorkItemFull(itemId));
  }],

  // --- Epic endpoints ---

  // List epics
  [/^\/api\/epics$/, 'GET', async (_m, _req, res) => {
    const epics = db.listEpics().map(epic => {
      const items = db.getWorkItemsByEpic(epic.id);
      const done = items.filter(i => i.status === 'done').length;
      return {
        ...epic,
        work_item_ids: items.map(i => i.id),
        project_keys: db.getEpicProjectKeys(epic.id),
        session_log: db.getEpicLogs(epic.id).map(l => ({ date: l.logged_at, summary: l.summary })),
        progress: { done, total: items.length },
      };
    });
    json(res, epics);
  }],

  // Get epic detail
  [/^\/api\/epics\/(E-\d+)$/, 'GET', async (m, _req, res) => {
    const epic = db.getEpicFull(m[1]);
    if (!epic) return err(res, 'epic not found', 404);
    json(res, epic);
  }],

  // Create epic
  [/^\/api\/epics$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { title, status, priority, description, acceptance_criteria, target_date, tags } = body;
    if (!title) return err(res, 'title is required', 400);
    if (status && !VALID_EPIC_STATUSES.has(status)) {
      return err(res, `invalid status '${status}', must be one of: ${[...VALID_EPIC_STATUSES].join(', ')}`, 400);
    }
    if (priority && !VALID_PRIORITIES.has(priority)) {
      return err(res, `invalid priority '${priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
    }
    const epic = db.createEpic({ title, status, priority, description, acceptance_criteria, target_date, tags });
    // Return with derived fields
    epic.work_item_ids = [];
    epic.project_keys = [];
    epic.session_log = db.getEpicLogs(epic.id).map(l => ({ date: l.logged_at, summary: l.summary }));
    json(res, epic, 201);
  }],

  // Update epic
  [/^\/api\/epics\/(E-\d+)$/, 'PATCH', async (m, req, res) => {
    const existing = db.getEpic(m[1]);
    if (!existing) return err(res, 'epic not found', 404);
    const body = await parseBody(req);
    if (body.status && !VALID_EPIC_STATUSES.has(body.status)) {
      return err(res, `invalid status '${body.status}', must be one of: ${[...VALID_EPIC_STATUSES].join(', ')}`, 400);
    }
    if (body.priority && !VALID_PRIORITIES.has(body.priority)) {
      return err(res, `invalid priority '${body.priority}', must be one of: ${[...VALID_PRIORITIES].join(', ')}`, 400);
    }
    const updated = db.updateEpic(m[1], body);
    updated.work_item_ids = db.getEpicWorkItemIds(m[1]);
    updated.project_keys = db.getEpicProjectKeys(m[1]);
    updated.session_log = db.getEpicLogs(m[1]).map(l => ({ date: l.logged_at, summary: l.summary }));
    json(res, updated);
  }],

  // Delete epic
  [/^\/api\/epics\/(E-\d+)$/, 'DELETE', async (m, _req, res) => {
    const archived = db.deleteEpic(m[1]);
    if (!archived) return err(res, 'epic not found', 404);
    json(res, { archived: m[1], status: 'cancelled' });
  }],

  // Archive epic (non-destructive — preserves links)
  [/^\/api\/epics\/(E-\d+)\/archive$/, 'POST', async (m, _req, res) => {
    const result = db.archiveEpic(m[1]);
    if (!result) {
      const epic = db.getEpic(m[1]);
      if (!epic) return err(res, 'epic not found', 404);
      return err(res, 'only done or cancelled epics can be archived', 400);
    }
    json(res, result);
  }],

  // Link work items to epic
  [/^\/api\/epics\/(E-\d+)\/link$/, 'POST', async (m, req, res) => {
    const body = await parseBody(req);
    const { work_item_ids } = body;
    if (!work_item_ids || !work_item_ids.length) return err(res, 'work_item_ids required', 400);
    try {
      const linked = db.linkItemsToEpic(m[1], work_item_ids);
      json(res, { linked, epic_id: m[1] });
    } catch (e) {
      return err(res, e.message, 404);
    }
  }],

  // Unlink work item from epic
  [/^\/api\/epics\/(E-\d+)\/unlink$/, 'POST', async (m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id } = body;
    if (!work_item_id) return err(res, 'work_item_id required', 400);
    const existing = db.getEpic(m[1]);
    if (!existing) return err(res, 'epic not found', 404);
    db.unlinkItemFromEpic(m[1], work_item_id);
    json(res, { unlinked: work_item_id, epic_id: m[1] });
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

  // Read a specific artifact file
  [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'GET', async (m, _req, res) => {
    try {
      const content = await readFile(join(WORK, 'items', m[1], m[2]), 'utf8');
      text(res, content);
    } catch {
      err(res, 'artifact not found', 404);
    }
  }],

  // Write a specific artifact file
  [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'PUT', async (m, req, res) => {
    const body = await parseBody(req);
    const dir = join(WORK, 'items', m[1]);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, m[2]), body.content || '');
    json(res, { saved: true });
  }],

  // Delete a specific artifact file
  [/^\/api\/work-items\/(W-\d+)\/artifacts\/([a-zA-Z0-9_-]+\.md)$/, 'DELETE', async (m, _req, res) => {
    try {
      await unlinkFile(join(WORK, 'items', m[1], m[2]));
      json(res, { deleted: m[2] });
    } catch {
      err(res, 'artifact not found', 404);
    }
  }],

  // --- CLI session endpoints ---

  // Register CLI session
  [/^\/api\/sessions\/register$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { project_key, title, pid, work_item_id, epic_id } = body;
    if (!project_key || !title || !pid) {
      return err(res, 'project_key, title, and pid are required', 400);
    }
    if (!isPidAlive(pid)) {
      return err(res, 'PID is not alive', 400);
    }
    const id = `C-${Date.now()}`;
    const session = {
      id,
      project_key,
      work_item_id: work_item_id || null,
      epic_id: epic_id || null,
      title,
      pid,
      status: 'running',
      registered_at: new Date().toISOString(),
      exited_at: null,
    };
    cliSessions.set(id, session);
    saveCliSessionToDb(session);
    json(res, { id, status: session.status, registered_at: session.registered_at }, 201);
  }],

  // List CLI sessions
  [/^\/api\/sessions\/active$/, 'GET', async (_m, _req, res) => {
    const list = [];
    for (const [, c] of cliSessions) {
      list.push({ ...c });
    }
    json(res, list);
  }],

  // Deregister CLI session
  [/^\/api\/sessions\/(C-[A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const session = cliSessions.get(m[1]);
    if (!session) return err(res, 'CLI session not found', 404);
    session.status = 'exited';
    session.exited_at = new Date().toISOString();
    saveCliSessionToDb(session);
    json(res, { status: 'exited', id: m[1] });
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
      permission_mode: 'acceptEdits',
      status: 'running',
      needs_input: false,
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
    dispatch.pid = proc.pid;
    dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
    dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

    wireDispatchHandlers(dispatch, proc);

    dispatches.set(id, dispatch);
    saveDispatchToDb(dispatch);
    json(res, { dispatch_id: id, status: 'running' });
  }],

  // --- Dispatch endpoints ---

  // Create dispatch
  [/^\/api\/dispatch$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions, permission_mode } = body;

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
      work_item_id ? loadWorkItem(work_item_id) : null,
    ]);

    let epicContext = null;
    if (epic_id) {
      try {
        const epicFull = db.getEpicFull(epic_id);
        if (epicFull) {
          const planSnippet = await loadEpicPlanSnippet(epic_id);
          epicContext = {
            id: epicFull.id,
            title: epicFull.title,
            status: epicFull.status,
            progress: `${epicFull.progress.done}/${epicFull.progress.total}`,
            acceptance_criteria: epicFull.acceptance_criteria,
            items: epicFull.resolved_items,
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

    const effectiveWorkItem = workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null);

    const prompt = buildDispatchPrompt({
      workItem: effectiveWorkItem,
      projectKey: project_key,
      projectPath,
      additionalInstructions: additional_instructions,
      portfolio,
      epicContext,
      relatedProjects,
    });

    // Select sub-agents based on work item and portfolio context
    const agentDefs = await selectAgentsForDispatch({ workItem: effectiveWorkItem, portfolio });

    // Resolve permission mode and skip_permissions independently
    const resolvedPermMode = permission_mode || 'acceptEdits';
    const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

    const dispatch = {
      id,
      work_item_id,
      epic_id: epic_id || null,
      project_key,
      project_path: projectPath,
      title: title || work_item_id || '',
      permission_mode: resolvedPermMode,
      skip_permissions: resolvedSkipPerms,
      status: 'running',
      needs_input: false,
      output: [],
      lastLines: [],
      listeners: new Set(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    let proc;
    try {
      const args = ['-p', '--output-format', 'stream-json', '--verbose'];
      args.push('--permission-mode', resolvedPermMode === 'plan' ? 'plan' : 'acceptEdits');
      if (resolvedSkipPerms) {
        args.push('--dangerously-skip-permissions');
      }
      // Give the agent access to the architect project directory
      args.push('--add-dir', ROOT);
      // Attach curated sub-agents
      if (agentDefs.length) {
        args.push('--agents', JSON.stringify(agentDefs));
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
    dispatch.pid = proc.pid;
    dispatch.logPath = join(LOGS_DIR, `${id}.jsonl`);
    dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });

    wireDispatchHandlers(dispatch, proc);

    dispatches.set(id, dispatch);
    saveDispatchToDb(dispatch);
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

    // Replay from log file (source of truth) or fall back to in-memory buffer
    const logPath = join(LOGS_DIR, `${dispatch.id}.jsonl`);
    try {
      const content = readFileSync(logPath, 'utf8');
      for (const line of content.split('\n')) {
        if (line.trim()) res.write(`data: ${line}\n\n`);
      }
    } catch {
      for (const line of dispatch.output) {
        res.write(`data: ${line}\n\n`);
      }
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
        needs_input: d.needs_input || false,
        permission_mode: d.permission_mode || 'acceptEdits',
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
      } else if (dispatch.pid && isPidAlive(dispatch.pid)) {
        try { process.kill(dispatch.pid, 'SIGTERM'); } catch {}
      }
      dispatch.status = 'killed';
      dispatch.completed_at = new Date().toISOString();
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      for (const listener of dispatch.listeners) listener(null);
      dispatch.listeners.clear();
      archiveSession(dispatch, 'dispatch');
      saveDispatchToDb(dispatch);
      killed++;
    }
    json(res, { killed });
  }],

  // Kill a dispatch
  [/^\/api\/dispatch\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const dispatch = dispatches.get(m[1]);
    if (!dispatch) return err(res, 'dispatch not found');
    if (dispatch.process) {
      const timer = killProcessGraceful(dispatch.process);
      dispatch.process.on('close', () => clearTimeout(timer));
    } else if (dispatch.pid && isPidAlive(dispatch.pid)) {
      try { process.kill(dispatch.pid, 'SIGTERM'); } catch {}
    }
    dispatch.status = 'killed';
    dispatch.completed_at = new Date().toISOString();
    if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
    if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
    archiveSession(dispatch, 'dispatch');
    for (const listener of dispatch.listeners) listener(null);
    dispatch.listeners.clear();
    dispatches.delete(m[1]);
    db.deleteDispatch(m[1]);
    unlinkFile(join(LOGS_DIR, `${m[1]}.jsonl`)).catch(() => {});
    json(res, { status: 'killed', id: m[1] });
  }],

  // --- Terminal endpoints ---

  // Create terminal session
  [/^\/api\/terminal$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id, epic_id, project_key, title, description, additional_instructions, skip_permissions, permission_mode } = body;

    if (!project_key) return err(res, 'project_key is required', 400);

    const projectPath = await resolveProjectPath(project_key);
    if (!projectPath) return err(res, `Could not resolve path for project: ${project_key}`, 400);

    const id = `T-${Date.now()}`;

    // Build prompt same as dispatch
    const [portfolio, workItem] = await Promise.all([
      loadPortfolioContext(project_key),
      work_item_id ? loadWorkItem(work_item_id) : null,
    ]);

    let epicContext = null;
    if (epic_id) {
      try {
        const epicFull = db.getEpicFull(epic_id);
        if (epicFull) {
          const planSnippet = await loadEpicPlanSnippet(epic_id);
          epicContext = {
            id: epicFull.id, title: epicFull.title, status: epicFull.status,
            progress: `${epicFull.progress.done}/${epicFull.progress.total}`,
            acceptance_criteria: epicFull.acceptance_criteria, items: epicFull.resolved_items, plan_snippet: planSnippet,
          };
        }
      } catch {}
    }

    const effectiveTermWorkItem = workItem || (work_item_id ? { id: work_item_id, title: title || '', description: description || '', status: 'open', priority: 'medium', tags: [], session_log: [] } : null);

    const prompt = buildDispatchPrompt({
      workItem: effectiveTermWorkItem,
      projectKey: project_key,
      projectPath,
      additionalInstructions: additional_instructions,
      portfolio,
      epicContext,
    });

    // Select sub-agents for terminal session
    const termAgentDefs = await selectAgentsForDispatch({ workItem: effectiveTermWorkItem, portfolio });

    // Resolve permission mode and skip_permissions independently
    const resolvedTermPermMode = permission_mode || 'acceptEdits';
    const resolvedTermSkipPerms = skip_permissions === true || skip_permissions === 'true';

    // Spawn interactive PTY with claude, optionally wrapped in tmux for restart survival
    let ptyProcess;
    let tmuxName = null;
    let agentsFile = null;
    try {
      const ptyArgs = [];
      if (resolvedTermSkipPerms) {
        ptyArgs.push('--dangerously-skip-permissions');
      }
      ptyArgs.push('--add-dir', ROOT);
      if (termAgentDefs.length) {
        if (TMUX_AVAILABLE) {
          // Write agents JSON to temp file to avoid ARG_MAX overflow in tmux
          const tmpDir = join(ROOT, 'tmp');
          try { await mkdir(tmpDir, { recursive: true }); } catch {}
          agentsFile = join(tmpDir, `agents-${id}.json`);
          writeFileSync(agentsFile, JSON.stringify(termAgentDefs));
        } else {
          ptyArgs.push('--agents', JSON.stringify(termAgentDefs));
        }
      }

      if (TMUX_AVAILABLE) {
        tmuxName = `architect-${id}`;
        // Build shell command that reads agents from temp file to stay within ARG_MAX
        const cliParts = [CLAUDE_BIN, ...ptyArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`)];
        if (agentsFile) {
          cliParts.push('--agents', `"$(cat '${agentsFile}')"`);
        }
        const shellCmd = cliParts.join(' ');
        // Create detached tmux session running claude via shell wrapper
        execFileSync('tmux', [
          'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24',
          'sh', '-c', shellCmd,
        ], { cwd: projectPath, env: { ...process.env, ARCHITECT_ROOT: ROOT } });
        // Attach node-pty to the tmux session for WebSocket streaming
        ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: projectPath,
          env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
        });
      } else {
        ptyProcess = pty.spawn(CLAUDE_BIN, ptyArgs, {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: projectPath,
          env: { ...process.env, TERM: 'xterm-256color', ARCHITECT_ROOT: ROOT },
        });
      }
    } catch (err) {
      // Clean up tmux session on failure
      if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
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
      permission_mode: resolvedTermPermMode,
      skip_permissions: resolvedTermSkipPerms,
      status: 'running',
      ptyProcess,
      pid: tmuxName
        ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
        : ptyProcess.pid,
      tmux_session: tmuxName,
      agents_file: agentsFile,
      scrollback: '',
      logStream: createWriteStream(join(LOGS_DIR, `${id}.raw`), { flags: 'a' }),
      wsClients: new Set(),
      started_at: new Date().toISOString(),
      exited_at: null,
    };

    wireTerminalHandlers(terminal);

    // After PTY is ready, write the prompt as first input
    // Tmux needs longer delay: session creation → claude starts → node-pty attaches
    setTimeout(() => {
      if (terminal.ptyProcess) {
        terminal.ptyProcess.write(prompt + '\r');
      }
    }, tmuxName ? 1500 : 500);

    terminals.set(id, terminal);
    saveTerminalToDb(terminal);
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
    const shellBin = process.env.SHELL || '/bin/zsh';

    let ptyProcess;
    let tmuxName = null;
    try {
      if (TMUX_AVAILABLE) {
        tmuxName = `architect-${id}`;
        execFileSync('tmux', [
          'new-session', '-d', '-s', tmuxName, '-x', '80', '-y', '24', shellBin,
        ], { cwd: projectPath });
        ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxName], {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: projectPath,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      } else {
        ptyProcess = pty.spawn(shellBin, [], {
          name: 'xterm-256color', cols: 80, rows: 24,
          cwd: projectPath,
          env: { ...process.env, TERM: 'xterm-256color' },
        });
      }
    } catch (e) {
      if (tmuxName) { try { execFileSync('tmux', ['kill-session', '-t', tmuxName], { stdio: 'ignore' }); } catch {} }
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
      permission_mode: 'acceptEdits',
      status: 'running',
      ptyProcess,
      pid: tmuxName
        ? parseInt(execFileSync('tmux', ['display-message', '-t', tmuxName, '-p', '#{pane_pid}'], { encoding: 'utf8' }).trim(), 10)
        : ptyProcess.pid,
      tmux_session: tmuxName,
      scrollback: '',
      logStream: createWriteStream(join(LOGS_DIR, `${id}.raw`), { flags: 'a' }),
      wsClients: new Set(),
      started_at: new Date().toISOString(),
      exited_at: null,
    };

    wireTerminalHandlers(terminal);

    terminals.set(id, terminal);
    saveTerminalToDb(terminal);
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
        permission_mode: t.permission_mode || 'acceptEdits',
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
      } else if (terminal.tmux_session && TMUX_AVAILABLE) {
        try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
      } else if (terminal.pid && isPidAlive(terminal.pid)) {
        try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
      }
      terminal.status = 'killed';
      terminal.exited_at = new Date().toISOString();
      if (terminal.logStream) { terminal.logStream.end(); terminal.logStream = null; }
      for (const ws of terminal.wsClients) {
        try { ws.send(JSON.stringify({ type: 'exit', code: -1 })); ws.close(); } catch {}
      }
      terminal.wsClients.clear();
      archiveSession(terminal, 'terminal');
      saveTerminalToDb(terminal);
      unlinkFile(join(LOGS_DIR, `${terminal.id}.raw`)).catch(() => {});
      killed++;
    }
    json(res, { killed });
  }],

  // Kill a terminal
  [/^\/api\/terminal\/([A-Za-z0-9_-]+)$/, 'DELETE', async (m, _req, res) => {
    const terminal = terminals.get(m[1]);
    if (!terminal) return err(res, 'terminal not found');
    if (terminal.ptyProcess) {
      try { terminal.ptyProcess.kill('SIGHUP'); } catch {}
    } else if (terminal.tmux_session && TMUX_AVAILABLE) {
      try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
    } else if (terminal.pid && isPidAlive(terminal.pid)) {
      try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
    }
    terminal.status = 'killed';
    terminal.exited_at = new Date().toISOString();
    if (terminal.logStream) { terminal.logStream.end(); terminal.logStream = null; }
    for (const ws of terminal.wsClients) {
      try { ws.send(JSON.stringify({ type: 'exit', code: -1 })); ws.close(); } catch {}
    }
    terminal.wsClients.clear();
    archiveSession(terminal, 'terminal');
    if (terminal.agents_file) unlinkFile(terminal.agents_file).catch(() => {});
    terminals.delete(m[1]);
    db.deleteTerminal(m[1]);
    unlinkFile(join(LOGS_DIR, `${m[1]}.raw`)).catch(() => {});
    json(res, { status: 'killed', id: m[1] });
  }],

  // --- Projects & Time Report endpoints ---

  [/^\/api\/projects$/, 'GET', async (_m, _req, res) => {
    json(res, db.getAllProjects());
  }],

  [/^\/api\/projects\/sync$/, 'POST', async (_m, _req, res) => {
    const count = syncProjectsFromRegistry();
    json(res, { synced: count });
  }],

  [/^\/api\/projects\/(.+)\/stats$/, 'GET', async (m, _req, res) => {
    const key = decodeURIComponent(m[1]);
    const project = db.getProject(key);
    if (!project) return err(res, 'project not found');
    const recentSessions = db.getSessionHistory({ project_key: key, limit: 20 });
    json(res, { ...project, recent_sessions: recentSessions });
  }],

  [/^\/api\/session-history$/, 'GET', async (_m, req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const filters = {};
    for (const k of ['project_key', 'epic_id', 'work_item_id']) {
      if (url.searchParams.get(k)) filters[k] = url.searchParams.get(k);
    }
    filters.limit = parseInt(url.searchParams.get('limit') || '50', 10);
    filters.offset = parseInt(url.searchParams.get('offset') || '0', 10);
    json(res, db.getSessionHistory(filters));
  }],

  [/^\/api\/time-report$/, 'GET', async (_m, _req, res) => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const { today, overall } = db.getTimeReport(todayStart.toISOString());
    const daily = db.getTimeReportDaily(14);
    const monthly = db.getTimeReportMonthly(6);
    const sum = (arr, k) => arr.reduce((s, r) => s + (r[k] || 0), 0);
    json(res, {
      today, overall, daily, monthly,
      today_total: { sessions: sum(today, 'sessions'), time_seconds: sum(today, 'time_seconds'), cost_usd: sum(today, 'cost_usd') },
      overall_total: { sessions: sum(overall, 'sessions'), time_seconds: sum(overall, 'time_seconds'), cost_usd: sum(overall, 'cost_usd') },
    });
  }],

  // --- Server management endpoints ---

  // Server status
  [/^\/api\/server\/status$/, 'GET', async (_m, _req, res) => {
    const uptimeSeconds = Math.floor((Date.now() - SERVER_START_TIME) / 1000);
    const dispatchesActive = [...dispatches.values()].filter(d => d.status === 'running').length;
    const terminalsActive = [...terminals.values()].filter(t => t.status === 'running').length;
    json(res, {
      pid: process.pid,
      port,
      uptime_seconds: uptimeSeconds,
      node_version: process.version,
      platform: process.platform,
      sessions: {
        dispatches_active: dispatchesActive,
        terminals_active: terminalsActive,
        cli_sessions_active: [...cliSessions.values()].filter(c => c.status === 'running').length,
        dispatches_total: dispatches.size,
        terminals_total: terminals.size,
        cli_sessions_total: cliSessions.size,
      },
    });
  }],

  // Server config
  [/^\/api\/server\/config$/, 'GET', async (_m, _req, res) => {
    const home = homedir();
    const launchdPlist = join(home, 'Library', 'LaunchAgents', 'com.architect.dashboard.plist');
    const systemdUnit = join(home, '.config', 'systemd', 'user', 'architect-dashboard.service');

    let autoStart = { installed: false, type: null, service_name: null };
    if (existsSync(launchdPlist)) {
      autoStart = { installed: true, type: 'launchd', service_name: 'com.architect.dashboard' };
    } else if (existsSync(systemdUnit)) {
      autoStart = { installed: true, type: 'systemd', service_name: 'architect-dashboard' };
    }

    json(res, {
      port,
      auto_start: autoStart,
      log_file: LOG_FILE,
      pid_file: PID_FILE,
      database_file: join(WORK, 'architect.db'),
    });
  }],

  // --- Preferences endpoints ---
  [/^\/api\/settings\/preferences$/, 'GET', async (_m, _req, res) => {
    json(res, db.getAllPreferences());
  }],

  [/^\/api\/settings\/preferences$/, 'PUT', async (_m, req, res) => {
    const body = await parseBody(req);
    for (const [key, value] of Object.entries(body)) {
      db.setPreference(key, String(value));
    }
    json(res, db.getAllPreferences());
  }],

  // Server action (restart, stop, fresh, install, uninstall)
  [/^\/api\/server\/action$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { action, clear_sessions } = body;
    const validActions = ['restart', 'stop', 'fresh', 'install', 'uninstall'];
    if (!action || !validActions.includes(action)) {
      return err(res, `Invalid action. Must be one of: ${validActions.join(', ')}`, 400);
    }

    if (action === 'install' || action === 'uninstall') {
      try {
        const output = execFileSync(DASHCTL_PATH, [action], {
          encoding: 'utf8',
          timeout: 15000,
          cwd: ROOT,
        });
        json(res, { status: 'done', output: output.trim() });
      } catch (e) {
        json(res, { status: 'error', output: e.stderr || e.message }, 500);
      }
      return;
    }

    // For restart/stop/fresh — spawn detached dashctl process
    const args = [action];
    if (action === 'fresh' && clear_sessions) {
      args.push('--clear-sessions');
    }

    try {
      const child = spawn(DASHCTL_PATH, args, {
        detached: true,
        stdio: 'ignore',
        cwd: ROOT,
      });
      child.unref();
      json(res, { status: action === 'stop' ? 'stopping' : 'restarting' });
    } catch (e) {
      json(res, { status: 'error', output: e.message }, 500);
    }
  }],

  // Server logs
  [/^\/api\/server\/logs$/, 'GET', async (_m, req, res) => {
    const reqUrl = new URL(req.url, 'http://localhost');
    const lines = parseInt(reqUrl.searchParams.get('lines') || '50', 10);

    try {
      const content = await readFile(LOG_FILE, 'utf8');
      const allLines = content.split('\n');
      const tail = allLines.slice(-Math.min(lines, allLines.length)).join('\n');
      text(res, tail);
    } catch (e) {
      if (e.code === 'ENOENT') {
        text(res, '(no log file yet)');
      } else {
        text(res, `Error reading log: ${e.message}`, 'text/plain', 500);
      }
    }
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
    // Replay scrollback buffer with PTY dimensions for client-side reflow awareness
    if (terminal.scrollback) {
      const dims = terminal.ptyProcess
        ? { cols: terminal.ptyProcess.cols, rows: terminal.ptyProcess.rows }
        : { cols: 80, rows: 24 };
      ws.send(JSON.stringify({ type: 'scrollback', data: terminal.scrollback, cols: dims.cols, rows: dims.rows }));
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

  // Terminals: check PID/tmux liveness for running without ptyProcess
  for (const [, terminal] of terminals) {
    if (terminal.status === 'running' && !terminal.ptyProcess) {
      const tmuxAlive = terminal.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(terminal.tmux_session);
      const pidAlive = terminal.pid && isPidAlive(terminal.pid);
      if (!tmuxAlive && !pidAlive) {
        terminal.status = 'interrupted';
        terminal.exited_at = new Date().toISOString();
        if (terminal.logStream) { terminal.logStream.end(); terminal.logStream = null; }
        saveTerminalToDb(terminal);
        archiveSession(terminal, 'terminal');
        for (const ws of terminal.wsClients) {
          try { ws.send(JSON.stringify({ type: 'exit', code: -1 })); ws.close(); } catch {}
        }
        terminal.wsClients.clear();
      }
    }
  }

  // Dispatches: check PID liveness for running without process handle
  for (const [, dispatch] of dispatches) {
    if (dispatch.status === 'running' && !dispatch.process && dispatch.pid) {
      if (!isPidAlive(dispatch.pid)) {
        dispatch.status = 'interrupted';
        dispatch.completed_at = new Date().toISOString();
        if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
        if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
        saveDispatchToDb(dispatch);
        archiveSession(dispatch, 'dispatch');
        for (const listener of dispatch.listeners) listener(null);
        dispatch.listeners.clear();
      }
    }
  }

  // CLI sessions: check PID liveness for running
  for (const [, cli] of cliSessions) {
    if (cli.status === 'running' && !isPidAlive(cli.pid)) {
      cli.status = 'exited';
      cli.exited_at = new Date().toISOString();
      saveCliSessionToDb(cli);
      archiveSession(cli, 'cli');
    }
  }

  // Auto-cleanup: remove exited terminals after 10 minutes
  for (const [id, terminal] of terminals) {
    if (terminal.status !== 'running' && terminal.exited_at) {
      if (now - new Date(terminal.exited_at).getTime() > 10 * 60 * 1000) {
        if (terminal.agents_file) unlinkFile(terminal.agents_file).catch(() => {});
        unlinkFile(join(LOGS_DIR, `${id}.raw`)).catch(() => {});
        terminals.delete(id);
        db.deleteTerminal(id);
      }
    }
  }

  // Auto-cleanup: remove non-running dispatches after 30 minutes
  for (const [id, dispatch] of dispatches) {
    if (dispatch.status !== 'running' && dispatch.completed_at) {
      if (now - new Date(dispatch.completed_at).getTime() > 30 * 60 * 1000) {
        dispatches.delete(id);
        db.deleteDispatch(id);
        unlinkFile(join(LOGS_DIR, `${id}.jsonl`)).catch(() => {});
      }
    }
  }

  // Auto-cleanup: remove exited CLI sessions after 10 minutes
  for (const [id, cli] of cliSessions) {
    if (cli.status !== 'running' && cli.exited_at) {
      if (now - new Date(cli.exited_at).getTime() > 10 * 60 * 1000) {
        cliSessions.delete(id);
        db.deleteCliSession(id);
      }
    }
  }
}, 60 * 1000);

function shutdownFlush() {
  const now = new Date().toISOString();

  // Dispatches: leave alive processes as running, mark dead ones as interrupted
  for (const [, d] of dispatches) {
    if (d.status !== 'running') continue;
    if (d.pid && isPidAlive(d.pid)) {
      // Process survives — close our handles but leave DB status as running
      if (d.logStream) { d.logStream.end(); d.logStream = null; }
      if (d._tailInterval) { clearInterval(d._tailInterval); d._tailInterval = null; }
    } else {
      d.status = 'interrupted';
      d.completed_at = now;
      saveDispatchToDb(d);
    }
  }

  // Terminals: leave alive tmux/PID sessions as running
  for (const [, t] of terminals) {
    if (t.status !== 'running') continue;
    const tmuxAlive = t.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(t.tmux_session);
    const pidAlive = t.pid && isPidAlive(t.pid);
    if (tmuxAlive || pidAlive) {
      // Will be reconnected on restart
    } else {
      t.status = 'interrupted';
      t.exited_at = now;
      saveTerminalToDb(t);
    }
  }

  db.closeDatabase();
}
process.on('SIGTERM', () => { shutdownFlush(); process.exit(0); });
process.on('SIGINT', () => { shutdownFlush(); process.exit(0); });

async function main() {
  // Phase 1: Database
  try {
    await db.initDatabaseAsync(WORK, MIGRATIONS_DIR);
    console.log('Database ready:', join(WORK, 'architect.db'));
  } catch (e) {
    console.error('Database initialization failed:', e.message);
    process.exit(1);
  }

  // Phase 2: Ensure logs directory
  await mkdir(LOGS_DIR, { recursive: true });

  // Phase 2.5: Sync projects from portfolio registry
  syncProjectsFromRegistry();

  // Phase 3: Restore sessions
  restoreSessions();

  // Phase 4: Start server
  server.listen(port, '127.0.0.1', () => {
    console.log(`Dashboard: http://127.0.0.1:${port}`);
  });
}

main().catch(e => {
  console.error('Server startup failed:', e);
  process.exit(1);
});
