import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
const SERVER = join(ROOT, 'tools', 'dashboard', 'server.mjs');
const BASE_PORT = 3800;

export const SPEC_FILES = [
  'regression',
  'scroll-behavior',
  'scroll-wheel',
  'cursor-scroll-independence',
  'terminal-experience',
  'panel-lifecycle',
  'modal-lifecycle',
  'routing',
  'work-item-flow',
  'api-contracts',
  'error-paths',
  'restart-recovery',
  'org-dispatch',
  'dispatch-scroll',
];

function getLiveDashboardPorts() {
  const ports = new Set();
  // Check env var set by dispatch session or dashctl
  if (process.env.PORT) ports.add(Number(process.env.PORT));
  // Check dashboard pid file for the managed dashboard
  try {
    const pidFile = join(ROOT, 'tmp', 'dashboard.pid');
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    const out = execFileSync('lsof', ['-p', String(pid), '-iTCP', '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
    const match = out.match(/:(\d+) \(LISTEN\)/);
    if (match) ports.add(Number(match[1]));
  } catch { /* no pid file or process gone */ }
  if (ports.size === 0) ports.add(3777);
  return ports;
}

function killStalePids() {
  // Kill recorded pids from the last run (may be pre-bind zombies not yet visible to lsof)
  try {
    const pidsFile = join(ROOT, 'tmp', 'test-server.pids');
    for (const pid of readFileSync(pidsFile, 'utf8').split(',').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    rmSync(pidsFile);
  } catch { /* file absent or already removed */ }

  // Also kill any lingering server.mjs processes using test work dirs
  try {
    const pwDirPattern = join(ROOT, 'tmp', 'pw-s');
    const out = execFileSync('pgrep', ['-f', pwDirPattern], { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean).map(Number)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* pgrep returns exit 1 when no match — that's fine */ }
}

function killAnyOnPort(port) {
  // Test ports (BASE_PORT range) are exclusively reserved for test servers.
  // Kill any process occupying them — live dashboard ports are already guarded before this runs.
  // Note: macOS lsof -t is broken (exits 1 even on match); parse the full table instead.
  try {
    const out = execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
    for (const line of out.split('\n').slice(1)) {
      const pid = Number(line.trim().split(/\s+/)[1]);
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  } catch { /* lsof returns exit 1 when port is clear — that's fine */ }
}

async function waitPortFree(port, maxMs = 5000) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      execFileSync('lsof', ['-i', `TCP:${port}`, '-sTCP:LISTEN', '-n', '-P'], { encoding: 'utf8' });
      // lsof succeeded → something is still listening; kill again and retry
      killAnyOnPort(port);
    } catch {
      // lsof exited 1 → nothing listening on this port
      return;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`Port ${port} did not clear within ${maxMs}ms`);
}

export default async function globalSetup() {
  const livePorts = getLiveDashboardPorts();

  // Kill PIDs from any prior run (recorded or zombie — kills before port bind race)
  killStalePids();

  // Kill anything currently listening on test ports and poll until all ports are free
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const port = BASE_PORT + i;
    if (livePorts.has(port)) {
      throw new Error(`Test port ${port} (${SPEC_FILES[i]}) collides with live dashboard. Live dashboard ports: ${[...livePorts].join(', ')}`);
    }
    killAnyOnPort(port);
  }
  await Promise.all(
    Array.from({ length: SPEC_FILES.length }, (_, i) => waitPortFree(BASE_PORT + i))
  );

  const procs = [];
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const port = BASE_PORT + i;
    const workDir = join(ROOT, 'tmp', `pw-s${i}`);
    mkdirSync(workDir, { recursive: true });
    // Drop stale DB and WAL files — each run starts from a clean slate (temp DB only, never work/architect.db)
    try { rmSync(join(workDir, 'architect.db')); } catch { /* ok */ }
    try { rmSync(join(workDir, 'architect.db-shm')); } catch { /* ok */ }
    try { rmSync(join(workDir, 'architect.db-wal')); } catch { /* ok */ }
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), WORK_DIR: workDir },
      stdio: 'ignore',
      detached: true,
    });
    proc.unref();
    procs.push({ port, pid: proc.pid });
  }
  // Write PIDs before waiting — lets the next run kill zombies even if setup fails here
  writeFileSync(join(ROOT, 'tmp', 'test-server.pids'), procs.map(p => p.pid).join(','), 'utf8');
  await Promise.all(procs.map(({ port, pid }) => waitReadyAndVerify(port, pid)));
}

async function waitReadyAndVerify(port, expectedPid, attempts = 50, delayMs = 250) {
  const url = `http://127.0.0.1:${port}/api/server/status`;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) {
        const data = await r.json();
        if (data.pid !== expectedPid) {
          // Stale process raced us to the port — kill it and let our server take over
          try { process.kill(data.pid, 'SIGKILL'); } catch { /* already gone */ }
          await new Promise(r => setTimeout(r, 200));
          continue;
        }
        return;
      }
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Test server (pid=${expectedPid}) never became ready on port ${port}`);
}
