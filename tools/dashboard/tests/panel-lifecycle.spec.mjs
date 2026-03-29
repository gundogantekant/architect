/**
 * Step 1 Gate: Panel Lifecycle Tests
 *
 * These tests define the behavioral contract for the createSessionPanel factory.
 * They are expected to pass after the factory is implemented.
 * Some tests may already pass on unmodified code if the existing behavior matches.
 *
 * Test server started automatically by globalSetup on an isolated port
 */

import { test, expect } from './fixtures.mjs';
import { purgeAll, seedDispatch } from './helpers.mjs';

import { SPEC_FILES } from './global-setup.mjs';
const BASE = `http://127.0.0.1:${3778 + (parseInt(process.env.TEST_WORKER_INDEX ?? '0') % SPEC_FILES.length)}`;

// Global purge before the suite: clears real claude processes left by prior test files
// (worker-scoped purgeAll cannot kill dispatches that have live process handles)
test.beforeAll(async () => {
  await fetch(`${BASE}/api/test/purge-all`, { method: 'POST' });
});

test.beforeEach(async () => { await purgeAll(); });

// ============================================================
// Suite A: Dispatch Panels (DP-1 to DP-10)
// ============================================================

test('DP-1: dispatch panel appears with status-running dot', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(BASE + '/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${id} .status-dot.running`)).toBeVisible();
});

test('DP-2: dispatch panel shows seeded output lines', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({
    status: 'completed',
    output: ['line one from test', 'line two from test'],
  });
  await page.goto(BASE + '/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  // Log content is loaded async — wait for it to be non-empty
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.textContent.trim().length > 0;
    },
    id,
    { timeout: 8000 },
  );
});

test('DP-3: collapse hides log, expand restores content', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto(BASE + '/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Click minimize button
  await page.locator(`[data-minimize-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).not.toBeVisible();

  // Click again to expand
  await page.locator(`[data-minimize-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).not.toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).toBeVisible();
});

test('DP-4: kill button kills dispatch and transitions panel to killed status', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(BASE + '/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-kill-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-killed/, { timeout: 5000 });
  await expect(page.locator(`#dispatch-${id} .status-dot.running`)).not.toBeVisible();
});

test('DP-5: suspend button transitions to suspended status', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running', claude_session_id: 'fake-session-for-test' });
  await page.goto(BASE + '/');
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-suspend-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-suspended/, { timeout: 10000 });
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).not.toBeVisible();
});

test('DP-6: resume button is visible on suspended panel', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended' });
  await page.goto(BASE + '/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).not.toBeVisible();
});

test('DP-7: focus popup opens when focus button clicked', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(BASE + '/');
  await expect(page.locator(`[data-focus-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-focus-dispatch="${id}"]`).click();
  // Focus overlay wraps the focus-popup
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.focus-popup')).toBeVisible({ timeout: 5000 });
});

test('DP-8: focus popup closes when close button clicked', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(BASE + '/');
  await page.locator(`[data-focus-dispatch="${id}"]`).click({ timeout: 5000 });
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });

  // Close via the btn-close button in the popup footer
  await page.locator('.focus-popup-footer .btn-close').click();
  await expect(page.locator('.focus-overlay')).not.toBeVisible({ timeout: 5000 });
});

test('DP-9: focus popup kill button kills dispatch', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(BASE + '/');
  await page.locator(`[data-focus-dispatch="${id}"]`).click({ timeout: 5000 });

  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });
  // Kill button is .btn-kill in the focus popup footer
  await page.locator('.focus-popup-footer .btn-kill').click();

  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-killed/, { timeout: 5000 });
});

test('DP-10: focus popup shows dispatch ID in content', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['unique-content-xyz'] });
  await page.goto(BASE + '/');
  await page.locator(`[data-focus-dispatch="${id}"]`).click({ timeout: 5000 });

  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });
  // Popup header or footer should show the dispatch ID
  await expect(page.locator('.focus-popup')).toContainText(id, { timeout: 5000 });
});

// ============================================================
// Suite B: CLI Session Panels (CLI-1 to CLI-4)
// ============================================================

/**
 * Helper: register a CLI session using a real alive PID (the dashboard server's own PID).
 * The /api/sessions/register endpoint validates PID liveness, so fake PIDs are rejected.
 */
async function registerCliSession(title) {
  // Fetch server PID from the status endpoint — it is always alive during tests
  const statusRes = await fetch(`${BASE}/api/server/status`);
  const { pid } = await statusRes.json();
  const res = await fetch(`${BASE}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, pid, project_key: 'ticari/architect/main' }),
  });
  return res.json();
}

test('CLI-1: CLI session panel appears after register', async ({ page }) => {
  const { id } = await registerCliSession('Test CLI session');
  await page.goto(BASE + '/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });
});

test('CLI-2: CLI session panel shows [CLI] badge', async ({ page }) => {
  const { id } = await registerCliSession('Badge test');
  await page.goto(BASE + '/');
  await expect(page.locator(`#cli-${id} .badge-cli`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#cli-${id} .badge-cli`)).toContainText('[CLI]');
});

test('CLI-3: CLI panel collapse hides body, expand shows it', async ({ page }) => {
  const { id } = await registerCliSession('Collapse test');
  await page.goto(BASE + '/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-minimize-cli="${id}"]`).click();
  await expect(page.locator(`#cli-${id}`)).toHaveClass(/collapsed/);

  await page.locator(`[data-minimize-cli="${id}"]`).click();
  await expect(page.locator(`#cli-${id}`)).not.toHaveClass(/collapsed/);
});

test('CLI-4: CLI panel has no kill or suspend buttons', async ({ page }) => {
  const { id } = await registerCliSession('No-kill test');
  await page.goto(BASE + '/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });

  // CLI panels must NOT have kill or suspend buttons
  await expect(page.locator(`#cli-${id} [class*="kill-btn"]`)).not.toBeVisible();
  await expect(page.locator(`#cli-${id} [class*="suspend-btn"]`)).not.toBeVisible();
});
