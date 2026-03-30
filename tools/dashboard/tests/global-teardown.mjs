import { readFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SPEC_FILES } from './global-setup.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

async function gracefulKill(pid, timeoutMs = 3000) {
  try { process.kill(pid, 'SIGTERM'); } catch { return; }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch { return; }
    await new Promise(r => setTimeout(r, 100));
  }
  // Still alive after timeout — force kill process group then individual
  try { process.kill(-pid, 'SIGKILL'); } catch { /* ignore */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

export default async function globalTeardown() {
  const pidsFile = join(ROOT, 'tmp', 'test-server.pids');

  // Kill test servers gracefully (SIGTERM → wait → SIGKILL)
  try {
    const pids = readFileSync(pidsFile, 'utf8').split(',').filter(Boolean).map(Number);
    await Promise.allSettled(pids.map(pid => gracefulKill(pid)));
    unlinkSync(pidsFile);
  } catch { /* ok if setup failed and file doesn't exist */ }

  // Clean up entire temp directories (DB + logs + any artifacts)
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const workDir = join(ROOT, 'tmp', `pw-s${i}`);
    try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
