/**
 * Shared server lifecycle utilities for test infrastructure.
 * Used by both global-setup.mjs (cleanup) and fixtures.mjs (lazy startup).
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
export const SERVER = join(ROOT, 'tools', 'dashboard', 'server.mjs');
export const BASE_PORT = 3800;

export function killAnyOnPort(port) {
  try {
    const out = execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
    for (const line of out.split('\n').slice(1)) {
      const pid = Number(line.trim().split(/\s+/)[1]);
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

export async function waitPortFree(port, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
      killAnyOnPort(port);
    } catch {
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} did not clear within ${maxMs}ms`);
}

export async function waitReadyAndVerify(port, expectedPid, attempts = 50, delayMs = 250) {
  const url = `http://127.0.0.1:${port}/api/server/status`;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        if (data.pid !== expectedPid) {
          try { process.kill(data.pid, 'SIGKILL'); } catch {}
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        return;
      }
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Test server (pid=${expectedPid}) never became ready on port ${port}`);
}

export function killStalePids() {
  try {
    const pidsFile = join(ROOT, 'tmp', 'test-server.pids');
    for (const pid of readFileSync(pidsFile, 'utf8').split(',').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    rmSync(pidsFile);
  } catch {}

  try {
    const pwDirPattern = join(ROOT, 'tmp', 'pw-s');
    const out = execFileSync('pgrep', ['-f', pwDirPattern], { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } catch {}
}

export async function gracefulKill(pid, timeoutMs = 3000) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  try { process.kill(-pid, 'SIGKILL'); } catch {}
  try { process.kill(pid, 'SIGKILL'); } catch {}
}

export function spawnTestServer(port, workDir) {
  mkdirSync(workDir, { recursive: true });
  try { rmSync(join(workDir, 'architect.db')); } catch {}
  try { rmSync(join(workDir, 'architect.db-shm')); } catch {}
  try { rmSync(join(workDir, 'architect.db-wal')); } catch {}

  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), WORK_DIR: workDir, PORTFOLIO_DIR: join(workDir, 'portfolio') },
    stdio: 'ignore',
    detached: true,
  });
  proc.unref();
  return proc;
}
