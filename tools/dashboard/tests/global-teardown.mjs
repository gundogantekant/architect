import { readFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_FILES } from './global-setup.mjs';
import { ROOT, gracefulKill } from './server-utils.mjs';

export default async function globalTeardown() {
  // Fallback: kill any servers that survived fixture teardown (e.g., worker crash)
  const pidsFile = join(ROOT, 'tmp', 'test-server.pids');
  try {
    const pids = readFileSync(pidsFile, 'utf8').split(',').filter(Boolean).map(Number);
    await Promise.allSettled(pids.map(pid => gracefulKill(pid)));
    unlinkSync(pidsFile);
  } catch {}

  // Clean up temp directories
  for (let i = 0; i < SPEC_FILES.length; i++) {
    const workDir = join(ROOT, 'tmp', `pw-s${i}`);
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}
