import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..');
const SERVER = join(ROOT, 'tools', 'dashboard', 'server.mjs');

export const SPEC_FILES = [
  'regression',
  'scroll-behavior',
  'terminal-experience',
  'panel-lifecycle',
  'modal-lifecycle',
  'routing',
  'work-item-flow',
  'api-contracts',
  'error-paths',
];

export default async function globalSetup() {
  const procs = [];
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const port = 3778 + i;
    if (port === 3777) throw new Error(`BUG: test server would collide with real dashboard port 3777`);
    const workDir = join(ROOT, 'tmp', `test-s${i}`);
    mkdirSync(workDir, { recursive: true });
    // Drop stale DB — each run starts from a clean slate (temp DB only, never work/architect.db)
    try { rmSync(join(workDir, 'architect.db')); } catch { /* ok */ }
    const proc = spawn(process.execPath, [SERVER], {
      env: { ...process.env, PORT: String(port), WORK_DIR: workDir },
      stdio: 'ignore',
      detached: false,
    });
    procs.push({ port, pid: proc.pid });
  }
  await Promise.all(procs.map(({ port }) => waitReady(`http://127.0.0.1:${port}/api/server/status`)));
  process.env._TEST_SERVER_PIDS = procs.map(p => p.pid).join(',');
}

async function waitReady(url, attempts = 40, delayMs = 250) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error(`Test server never became ready: ${url}`);
}
