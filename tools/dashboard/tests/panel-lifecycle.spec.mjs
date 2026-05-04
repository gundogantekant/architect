/**
 * Step 1 Gate: Panel Lifecycle Tests
 *
 * These tests define the behavioral contract for the createSessionPanel factory.
 * They are expected to pass after the factory is implemented.
 * Some tests may already pass on unmodified code if the existing behavior matches.
 *
 * Test server started automatically by globalSetup on an isolated port
 */

import { test as baseTest, expect } from './fixtures.mjs';
import { getBase, seedDispatch, api } from './helpers.mjs';

// Default test object uses expanded panels (from fixtures.mjs _defaultExpanded)
const test = baseTest;

// Tests that verify collapsed-by-default behavior override the fixture to no-op
const testCollapsed = baseTest.extend({
  _defaultExpanded: [async ({}, use) => { await use(); }, { scope: 'test', auto: true }],
});

const _PL_PROJECT_KEY = 'ticari/architect/main';
const _PL_PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

// Global purge before the suite: clears real claude processes left by prior test files
// (worker-scoped purgeAll cannot kill dispatches that have live process handles)
test.beforeAll(async () => {
  await fetch(`${getBase()}/api/test/purge-all`, { method: 'POST' });
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: _PL_PROJECT_KEY, entry: _PL_PORTFOLIO_ENTRY }),
  });
});


// ============================================================
// Suite A: Dispatch Panels (DP-1 to DP-10)
// ============================================================

test('DP-1: dispatch panel appears with status-running dot', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${id} .status-dot.generating`)).toBeVisible();
});

test('DP-2: dispatch panel shows seeded output lines', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({
    status: 'completed',
    output: ['line one from test', 'line two from test'],
  });
  await page.goto('/');
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

testCollapsed('DP-3: toggle expand/collapse works on default-collapsed panel', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Panels default to collapsed — verify initial state
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).not.toBeVisible();

  // Click minimize button to expand
  await page.locator(`[data-minimize-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).not.toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).toBeVisible();

  // Click again to collapse
  await page.locator(`[data-minimize-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).not.toBeVisible();
});

test('DP-4: kill button kills dispatch and transitions panel to killed status', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-kill-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-killed/, { timeout: 5000 });
  await expect(page.locator(`#dispatch-${id} .status-dot.running`)).not.toBeVisible();
});

test('DP-5: suspend button transitions to suspended status', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running', claude_session_id: 'fake-session-for-test' });
  await page.goto('/');
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-suspend-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-suspended/, { timeout: 10000 });
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).not.toBeVisible();
});

test('DP-6: resume button is visible on suspended panel', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`[data-resume-dispatch="${id}"]`)).toBeVisible();
  await expect(page.locator(`[data-suspend-dispatch="${id}"]`)).not.toBeVisible();
});

test('DP-7: focus popup opens when focus button clicked', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await expect(page.locator(`[data-focus-dispatch="${id}"]`)).toBeVisible({ timeout: 5000 });

  await page.locator(`[data-focus-dispatch="${id}"]`).click();
  // Focus overlay wraps the focus-popup
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.focus-popup')).toBeVisible({ timeout: 5000 });
});

test('DP-8: focus popup closes when close button clicked', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await page.locator(`[data-focus-dispatch="${id}"]`).click({ timeout: 5000 });
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });

  // Close via the btn-close button in the popup footer
  await page.locator('.focus-popup-footer .btn-close').click();
  await expect(page.locator('.focus-overlay')).not.toBeVisible({ timeout: 5000 });
});

test('DP-9: focus popup kill button kills dispatch', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await page.locator(`[data-focus-dispatch="${id}"]`).click({ timeout: 5000 });

  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });
  // Kill button is .btn-kill in the focus popup footer
  await page.locator('.focus-popup-footer .btn-kill').click();

  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-killed/, { timeout: 5000 });
});

test('DP-10: focus popup shows dispatch ID in content', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed', output: ['unique-content-xyz'] });
  await page.goto('/');
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
  const statusRes = await fetch(`${getBase()}/api/server/status`);
  const { pid } = await statusRes.json();
  const res = await fetch(`${getBase()}/api/sessions/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, pid, project_key: 'ticari/architect/main' }),
  });
  return res.json();
}

test('CLI-1: CLI session panel appears after register', async ({ page }) => {
  const { id } = await registerCliSession('Test CLI session');
  await page.goto('/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });
});

test('CLI-2: CLI session panel shows [CLI] badge', async ({ page }) => {
  const { id } = await registerCliSession('Badge test');
  await page.goto('/');
  await expect(page.locator(`#cli-${id} .badge-cli`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#cli-${id} .badge-cli`)).toContainText('[CLI]');
});

testCollapsed('CLI-3: CLI panel toggle expand/collapse works on default-collapsed panel', async ({ page }) => {
  const { id } = await registerCliSession('Collapse test');
  await page.goto('/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });

  // CLI panels default to collapsed
  await expect(page.locator(`#cli-${id}`)).toHaveClass(/collapsed/);

  // Click to expand
  await page.locator(`[data-minimize-cli="${id}"]`).click();
  await expect(page.locator(`#cli-${id}`)).not.toHaveClass(/collapsed/, { timeout: 10_000 });

  // Click to collapse again
  await page.locator(`[data-minimize-cli="${id}"]`).click({ force: true });
  await expect(page.locator(`#cli-${id}`)).toHaveClass(/collapsed/);
});

test('CLI-4: CLI panel has no kill or suspend buttons', async ({ page }) => {
  const { id } = await registerCliSession('No-kill test');
  await page.goto('/');
  await expect(page.locator(`#cli-${id}`)).toBeVisible({ timeout: 5000 });

  // CLI panels must NOT have kill or suspend buttons
  await expect(page.locator(`#cli-${id} [class*="kill-btn"]`)).not.toBeVisible();
  await expect(page.locator(`#cli-${id} [class*="suspend-btn"]`)).not.toBeVisible();
});

// ============================================================
// Suite C: Context-Aware Panel Expand/Collapse (DP-11 to DP-15)
// ============================================================

testCollapsed('DP-11: new dispatch panel defaults to collapsed', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#log-${id}`)).not.toBeVisible();
});

test('DP-12: relevant panels auto-expand when navigating to their project view', async ({ page }) => {
  // Seed 2 dispatches for architect, 3 for neuronic-cloud
  // Panels start expanded (via _defaultExpanded fixture setting the preference).
  // Context-aware logic COLLAPSES non-matching panels — deterministic.
  const arch1 = await seedDispatch({ status: 'running', project_key: 'ticari/architect/main', title: 'Arch dispatch 1' });
  const arch2 = await seedDispatch({ status: 'running', project_key: 'ticari/architect/main', title: 'Arch dispatch 2' });
  const nc1 = await seedDispatch({ status: 'running', project_key: 'ticari/neuronic-cloud/main', title: 'NC dispatch 1' });
  const nc2 = await seedDispatch({ status: 'running', project_key: 'ticari/neuronic-cloud/main', title: 'NC dispatch 2' });
  const nc3 = await seedDispatch({ status: 'running', project_key: 'ticari/neuronic-cloud/main', title: 'NC dispatch 3' });

  // Navigate to architect project view
  await page.goto('/#component/ticari/architect/main');
  await expect(page.locator(`#dispatch-${arch1.dispatch_id}`)).toBeVisible({ timeout: 30_000 });

  // Architect panels should be expanded (matching project, kept expanded)
  await expect(page.locator(`#dispatch-${arch1.dispatch_id}`)).not.toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${arch2.dispatch_id}`)).not.toHaveClass(/collapsed/);

  // Neuronic-cloud panels should be collapsed (non-matching project, collapsed by context-aware)
  await expect(page.locator(`#dispatch-${nc1.dispatch_id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${nc2.dispatch_id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${nc3.dispatch_id}`)).toHaveClass(/collapsed/);
});

test('DP-13: navigating to a different project flips expand/collapse', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: 'ticari/architect/main', title: 'Arch flip' });
  const nc = await seedDispatch({ status: 'running', project_key: 'ticari/neuronic-cloud/main', title: 'NC flip' });

  // Start on architect view — architect expanded, NC collapsed
  await page.goto('/#component/ticari/architect/main');
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).not.toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).toHaveClass(/collapsed/);

  // Navigate to neuronic-cloud view — NC expanded, architect collapsed
  await page.evaluate(() => { location.hash = '#component/ticari/neuronic-cloud/main'; });
  await page.waitForTimeout(500);
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).not.toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toHaveClass(/collapsed/);
});

test('DP-14: manual toggle within a project view is respected', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running', project_key: 'ticari/architect/main', title: 'Manual toggle' });

  // Navigate to architect view — panel auto-expands
  await page.goto('/#component/ticari/architect/main');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });
  await expect(page.locator(`#dispatch-${id}`)).not.toHaveClass(/collapsed/);

  // Manually collapse
  await page.locator(`[data-minimize-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);

  // Panel stays collapsed — manual toggle is respected
  await page.waitForTimeout(300);
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/collapsed/);
});

testCollapsed('DP-15: no auto-expand on generic views (home)', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: 'ticari/architect/main', title: 'Home test 1' });
  const nc = await seedDispatch({ status: 'running', project_key: 'ticari/neuronic-cloud/main', title: 'Home test 2' });

  // Navigate to home (no project context)
  await page.goto('/');
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 5000 });

  // All panels should be collapsed (default state, no context-driven expand)
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toHaveClass(/collapsed/);
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).toHaveClass(/collapsed/);
});
