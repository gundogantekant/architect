import { test as base, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_FILES } from './global-setup.mjs';
import { purgeAll } from './helpers.mjs';
import { ROOT, BASE_PORT, killAnyOnPort, waitPortFree, waitReadyAndVerify, gracefulKill, spawnTestServer } from './server-utils.mjs';

export const test = base.extend({
  // Worker fixture: spawns a dedicated test server for this spec file.
  // Server starts lazily when the worker needs it, not upfront for all 15 specs.
  _workerPort: [async ({}, use, workerInfo) => {
    const specName = workerInfo.project.name.replace(/\/(chromium|firefox)$/, '');
    const idx = SPEC_FILES.indexOf(specName);
    if (idx < 0) throw new Error(`Unknown spec "${specName}" — add it to SPEC_FILES in global-setup.mjs`);
    const port = BASE_PORT + idx;
    const workDir = join(ROOT, 'tmp', `pw-s${idx}`);

    // Ensure port is free, then spawn server
    killAnyOnPort(port);
    await waitPortFree(port);
    const proc = spawnTestServer(port, workDir);

    // Wait for server to be fully ready
    await waitReadyAndVerify(port, proc.pid);

    process.env.TEST_SERVER_PORT = String(port);
    await use(port);

    // Teardown: gracefully kill server and clean up work dir
    await gracefulKill(proc.pid);
    try { rmSync(workDir, { recursive: true, force: true }); } catch {}
  }, { scope: 'worker', auto: true }],

  // Auto test fixture: purges all test data before each test.
  _autoPurge: [async ({}, use) => {
    await purgeAll();
    await use();
  }, { scope: 'test', auto: true }],

  // Auto test fixture: disables auto-dismiss (W-843) so completed/exited session
  // panels persist during tests. Override with a no-op in auto-dismiss.spec.mjs.
  _disableAutoDismiss: [async ({ page }, use) => {
    await page.addInitScript(() => { window._testDisableAutoDismiss = true; });
    await use();
  }, { scope: 'test', auto: true }],
});

export { expect };
