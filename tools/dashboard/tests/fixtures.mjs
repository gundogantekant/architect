/**
 * Test fixtures for dashboard E2E tests.
 *
 * Auto-fixtures (applied to every test unless overridden):
 *   _workerPort         — spawns an isolated test server per spec file
 *   _autoPurge          — purges all test data before each test
 *   _disableAutoDismiss — prevents auto-dismiss of completed panels (override in auto-dismiss.spec)
 *   _defaultExpanded    — sets default_panel_state to 'expanded' (override in panel-lifecycle.spec)
 *
 * Override pattern (see auto-dismiss.spec.mjs):
 *   const test = baseTest.extend({
 *     _fixtureName: [async ({}, use) => { await use(); }, { scope: 'test', auto: true }],
 *   });
 */

import { test as base, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { SPEC_FILES } from './global-setup.mjs';
import { purgeAll } from './helpers.mjs';
import { ROOT, BASE_PORT, killAnyOnPort, waitPortFree, waitReadyAndVerify, gracefulKill, spawnTestServer, createTestDb, dropTestDb, testDbName } from './server-utils.mjs';

export const test = base.extend({
  // Worker fixture: spawns a dedicated test server backed by an isolated
  // PostgreSQL database. The DB is created before the server starts and
  // dropped (WITH FORCE) after teardown.
  _workerPort: [async ({}, use, workerInfo) => {
    const specName = workerInfo.project.name.replace(/\/(chromium|firefox)$/, '');
    const idx = SPEC_FILES.indexOf(specName);
    if (idx < 0) throw new Error(`Unknown spec "${specName}" — add it to SPEC_FILES in global-setup.mjs`);
    const port = BASE_PORT + idx;
    const workDir = join(ROOT, 'tmp', `pw-s${idx}`);
    const dbName = testDbName(port);

    // Create isolated test DB, ensure port is free, then spawn server.
    await createTestDb(dbName);
    killAnyOnPort(port);
    await waitPortFree(port);
    const proc = spawnTestServer(port, workDir, dbName);

    // Wait for server to be fully ready.
    await waitReadyAndVerify(port, proc.pid);

    process.env.TEST_SERVER_PORT = String(port);
    await use(port);

    // Teardown: kill server, drop test DB, clean up work dir.
    await gracefulKill(proc.pid);
    await dropTestDb(dbName).catch(() => {});
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

  // Auto test fixture: defaults panels to expanded so tests can interact with
  // terminal containers and dispatch logs. Uses addInitScript for 100% reliability
  // under parallel load (no network dependency).
  // Tests verifying collapse behavior (panel-lifecycle DP-3/DP-11/DP-15, CLI-3)
  // override this to no-op.
  _defaultExpanded: [async ({ page }, use) => {
    await page.addInitScript(() => { window._testDefaultExpanded = true; });
    await use();
  }, { scope: 'test', auto: true }],
});

export { expect };
