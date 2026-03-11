#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { spawn } from 'node:child_process';

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

// --- Dispatch registry (ephemeral, in-memory) ---
const dispatches = new Map();

async function resolveProjectPath(projectKey) {
  const registry = await readJson(join(PORTFOLIO, 'registry.json'));
  for (const [path, entry] of Object.entries(registry.entries)) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    if (key === projectKey) return path;
  }
  return null;
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
  [/^\/api\/backlog$/, 'GET', async (_m, _req, res) => {
    json(res, await readJson(join(WORK, 'backlog.json')));
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
      blocked_by: '',
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
    const allowed = ['title', 'status', 'priority', 'description', 'tags', 'blocked_by'];

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

  // --- Dispatch endpoints ---

  // Create dispatch
  [/^\/api\/dispatch$/, 'POST', async (_m, req, res) => {
    const body = await parseBody(req);
    const { work_item_id, project_key, title, description, additional_instructions } = body;

    if (!work_item_id || !project_key) {
      return err(res, 'work_item_id and project_key are required', 400);
    }

    const projectPath = await resolveProjectPath(project_key);
    if (!projectPath) {
      return err(res, `Could not resolve path for project: ${project_key}`, 400);
    }

    const id = `D-${Date.now()}`;
    const prompt = [
      `Work on backlog item ${work_item_id}: ${title || ''}`,
      `Project: ${project_key}`,
      description ? `Description: ${description}` : '',
      additional_instructions ? `Additional instructions: ${additional_instructions}` : '',
    ].filter(Boolean).join('\n');

    const dispatch = {
      id,
      work_item_id,
      project_key,
      project_path: projectPath,
      status: 'running',
      output: [],
      listeners: new Set(),
      started_at: new Date().toISOString(),
      completed_at: null,
    };

    const proc = spawn('claude', ['-p', '--output-format', 'stream-json', prompt], {
      cwd: projectPath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    dispatch.process = proc;

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
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
    });

    dispatches.set(id, dispatch);
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

  // List active dispatches
  [/^\/api\/dispatch\/active$/, 'GET', async (_m, _req, res) => {
    const list = [];
    for (const [id, d] of dispatches) {
      list.push({
        id,
        work_item_id: d.work_item_id,
        project_key: d.project_key,
        project_path: d.project_path,
        status: d.status,
        started_at: d.started_at,
        completed_at: d.completed_at,
      });
    }
    json(res, list);
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

server.listen(port, '127.0.0.1', () => {
  console.log(`Dashboard: http://127.0.0.1:${port}`);
});
