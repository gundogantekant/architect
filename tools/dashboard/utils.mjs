import { readFile, readdir } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LOGS_DIR } from './constants.mjs';

const execFileAsync = promisify(execFile);

// Cap every tmux exec so a wedged tmux server surfaces as an error instead of
// an infinite await that would hang prompt delivery forever.
const TMUX_EXEC_TIMEOUT_MS = 3000;

export function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function text(res, data, mime = 'text/plain', status = 200) {
  res.writeHead(status, { 'Content-Type': mime });
  res.end(data);
}

export function err(res, msg, status = 404) { json(res, { error: msg }, status); }

export function safe(segment) {
  return !segment.includes('..') && !segment.includes('/') && !segment.includes('\\');
}

const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-8',
  haiku:  'claude-haiku-4-5-20251001',
};

const RESOLVED_MODELS = new Set(Object.values(MODEL_ALIASES));

// Idempotent: accepts a short alias ('opus') or an already-resolved id ('claude-opus-4-8').
// A resolved id passes through unchanged so re-validating a persisted model (e.g. when a
// plan_execute phase-2 inherits its phase-1 model) does not silently fall back to sonnet.
export function validateModel(value) {
  if (RESOLVED_MODELS.has(value)) return value;
  return MODEL_ALIASES[value] ?? MODEL_ALIASES.sonnet;
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function listDirs(base) {
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter(e => e.isDirectory()).map(e => e.name);
}

export async function listFiles(base) {
  const entries = await readdir(base, { withFileTypes: true });
  return entries.filter(e => e.isFile()).map(e => e.name);
}

export async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function tmuxSessionExists(name) {
  try {
    execFileSync('tmux', ['has-session', '-t', name], { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

export function captureTmuxScrollback(name) {
  try {
    return execFileSync('tmux', ['capture-pane', '-t', name, '-p', '-e', '-S', '-1000'], { encoding: 'utf8' });
  } catch { return ''; }
}

// Async tmux delivery helpers for the tmux prompt-injection state machine
// (injection/index.mjs). All use promisify(execFile) so the SSE event loop is
// never blocked in the ~250ms poll, and all are fail-soft.

// Raw visible-pane text of the current render. Differs from captureTmuxScrollback
// on purpose: NO `-e` flag, so colour/SGR sequences are omitted and two idle
// renders are byte-comparable for inputRegionStable() stabilization checks.
export async function tmuxCapturePane(name) {
  try {
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-t', name, '-p'], { timeout: TMUX_EXEC_TIMEOUT_MS });
    return stdout;
  } catch { return ''; }
}

// Deliver text into the composer via the tmux buffer rather than send-keys, so
// the prompt is bracketed-pasted atomically. `-r` is MANDATORY: without it tmux
// rewrites each LF to CR, re-fragmenting a multi-line prompt into many Enters.
export async function tmuxPasteStdin(name, text) {
  const bufName = `arch-${name}`;
  try { await execFileAsync('tmux', ['delete-buffer', '-b', bufName]); } catch {}
  await loadTmuxBufferFromStdin(bufName, text);
  await execFileAsync('tmux', ['paste-buffer', '-t', name, '-b', bufName, '-p', '-r', '-d'], { timeout: TMUX_EXEC_TIMEOUT_MS });
}

// promisify(execFile) ignores the `input` option (that is execFileSync/spawnSync
// only), so `load-buffer -` would block forever on an unwritten stdin. Feed the
// buffer text through the child's stdin explicitly and close it to signal EOF.
function loadTmuxBufferFromStdin(bufName, text) {
  return new Promise((resolve, reject) => {
    const child = execFile('tmux', ['load-buffer', '-b', bufName, '-'], { timeout: TMUX_EXEC_TIMEOUT_MS }, (err) => {
      if (err) reject(err); else resolve();
    });
    child.stdin.on('error', reject);
    child.stdin.end(text);
  });
}

// Clear the composer (Ctrl-U) so a retry can never append to a partial buffer.
// Fail-soft: pre-paste hygiene, a failure here is not fatal to delivery.
export async function tmuxClearInput(name) {
  try { await execFileAsync('tmux', ['send-keys', '-t', name, 'C-u'], { timeout: TMUX_EXEC_TIMEOUT_MS }); } catch {}
}

// Submit the composer. Key name (not a literal CR) so tmux maps it to Enter.
// Returns true on success, false on exec error — a failed Enter must NOT be
// reported as a submitted turn, so the caller can verify before claiming done.
export async function tmuxSendEnter(name) {
  try {
    await execFileAsync('tmux', ['send-keys', '-t', name, 'Enter'], { timeout: TMUX_EXEC_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

/** Clean tmux capture-pane plain text output: strip trailing whitespace, collapse blank runs, trim */
export function cleanTmuxCapture(text) {
  const lines = text.split('\n').map(l => l.trimEnd());
  const result = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line === '') {
      blankCount++;
      if (blankCount <= 2) result.push(line);
    } else {
      blankCount = 0;
      result.push(line);
    }
  }
  while (result.length && result[0] === '') result.shift();
  while (result.length && result[result.length - 1] === '') result.pop();
  // Use \r\n so xterm.js moves cursor to column 0 on each new line
  // (xterm's convertEol is false by default — \n alone only moves down, not to col 0)
  return result.join('\r\n') + '\r\n';
}

export function termEventLogPath(id) {
  return join(LOGS_DIR, `T-${id}.events.jsonl`);
}

export function generateSeedContent(n = 500) {
  const lines = [];
  const commits = ['a1b2c3d', 'e4f5g6h', '7i8j9k0', 'l1m2n3o', 'p4q5r6s'];
  const files = ['src/index.mjs', 'src/db.mjs', 'tools/dashboard/server.mjs', 'domain/entities.md', 'portfolio/registry.json']; // synthetic test seed content — not a live read

  for (let i = 0; i < n; i++) {
    const r = i % 7;
    if (r === 0) lines.push(`\x1b[33mcommit ${commits[i % commits.length]}def${i}\x1b[0m`);
    else if (r === 1) lines.push(`Author: dev <dev@example.com>  Date: 2026-03-${(i % 28) + 1}`);
    else if (r === 2) lines.push(`    feat: update ${files[i % files.length]} (line ${i})`);
    else if (r === 3) lines.push('');
    else if (r === 4) lines.push(`\x1b[36m${files[i % files.length]}\x1b[0m  ${(i * 13) % 512} bytes`);
    else if (r === 5) lines.push(`\x1b[32m\u2713\x1b[0m compiled ${files[i % files.length]} in ${(i % 200) + 10}ms`);
    else lines.push(`${'─'.repeat(60)} [${i}/${n}]`);
  }
  return lines;
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
