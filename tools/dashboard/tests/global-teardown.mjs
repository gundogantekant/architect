import { readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default async function globalTeardown() {
  const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');
  const pidsFile = join(ROOT, 'tmp', 'test-server.pids');
  try {
    const pids = readFileSync(pidsFile, 'utf8').split(',').filter(Boolean);
    for (const pid of pids) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
    }
    unlinkSync(pidsFile);
  } catch { /* ok if setup failed and file doesn't exist */ }
}
