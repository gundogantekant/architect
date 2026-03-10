#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';

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

const routes = [
  // Static: index.html
  [/^\/$/, async (_m, _req, res) => {
    const html = await readFile(join(import.meta.dirname, 'index.html'), 'utf8');
    text(res, html, 'text/html');
  }],

  // Registry
  [/^\/api\/registry$/, async (_m, _req, res) => {
    json(res, await readJson(join(PORTFOLIO, 'registry.json')));
  }],

  // List orgs
  [/^\/api\/orgs$/, async (_m, _req, res) => {
    json(res, await listDirs(PORTFOLIO));
  }],

  // Org detail
  [/^\/api\/org\/([a-zA-Z0-9_-]+)$/, async (m, _req, res) => {
    if (!safe(m[1])) return err(res, 'invalid org', 400);
    json(res, await readJson(join(PORTFOLIO, m[1], 'organization.json')));
  }],

  // Org projects
  [/^\/api\/org\/([a-zA-Z0-9_-]+)\/projects$/, async (m, _req, res) => {
    if (!safe(m[1])) return err(res, 'invalid org', 400);
    json(res, await listDirs(join(PORTFOLIO, m[1])));
  }],

  // Project files
  [/^\/api\/project\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)$/, async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2])) return err(res, 'invalid path', 400);
    json(res, await listFiles(join(PORTFOLIO, m[1], m[2])));
  }],

  // Component JSON
  [/^\/api\/component\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
    const name = m[3].endsWith('.json') ? m[3] : m[3] + '.json';
    json(res, await readJson(join(PORTFOLIO, m[1], m[2], name)));
  }],

  // Doc (markdown)
  [/^\/api\/doc\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_-]+)\/([a-zA-Z0-9_.-]+)$/, async (m, _req, res) => {
    if (!safe(m[1]) || !safe(m[2]) || !safe(m[3])) return err(res, 'invalid path', 400);
    const content = await readFile(join(PORTFOLIO, m[1], m[2], m[3]), 'utf8');
    text(res, content, 'text/plain');
  }],

  // Backlog
  [/^\/api\/backlog$/, async (_m, _req, res) => {
    json(res, await readJson(join(WORK, 'backlog.json')));
  }],
];

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  for (const [pattern, handler] of routes) {
    const match = path.match(pattern);
    if (match) {
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
