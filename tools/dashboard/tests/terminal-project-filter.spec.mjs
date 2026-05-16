/**
 * W-1148: Terminal project filter tests
 *
 * Verifies that _placeSessionPanelsNow() hides terminal and dispatch panels
 * that don't belong to the active route's project context, using the
 * off-DOM _hiddenPanelBuffer approach (non-destructive hiding).
 *
 * Contract:
 *   - On #component/org/proj/comp: only panels matching that project_key are in DOM
 *   - On #agents: all panels are in DOM regardless of project_key
 *   - On home (/): all panels with project_key are in DOM (no filter)
 *   - Sessions with null/empty project_key are always shown
 */

import { test as baseTest, expect } from './fixtures.mjs';
import { getBase, seedDispatch, api } from './helpers.mjs';

const test = baseTest;

const _ARCH_KEY = 'ticari/architect/main';
const _NC_KEY   = 'ticari/neuronic-cloud/main';
const _PORTFOLIO_ENTRY = { worktree_mode: 'auto', worktree_setup: { branch: 'main' } };

test.beforeAll(async () => {
  await fetch(`${getBase()}/api/test/purge-all`, { method: 'POST' });
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: _ARCH_KEY, entry: _PORTFOLIO_ENTRY }),
  });
  await api('test/seed-portfolio-entry', {
    method: 'POST',
    body: JSON.stringify({ project_key: _NC_KEY, entry: _PORTFOLIO_ENTRY }),
  });
});

// ============================================================
// PF-1: component route hides non-matching panels
// ============================================================
test('PF-1: non-matching project panels are removed from DOM on component route', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Arch panel' });
  const nc   = await seedDispatch({ status: 'running', project_key: _NC_KEY,   title: 'NC panel' });

  await page.goto(`/#component/${_ARCH_KEY}`);
  // Architect panel must be in the live DOM
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 10_000 });

  // Neuronic-cloud panel must NOT be in the live DOM (moved to _hiddenPanelBuffer)
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).not.toBeAttached({ timeout: 5_000 });
});

// ============================================================
// PF-2: matching panels are visible on component route
// ============================================================
test('PF-2: matching project panels remain visible on component route', async ({ page }) => {
  const arch1 = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Arch 1' });
  const arch2 = await seedDispatch({ status: 'completed', project_key: _ARCH_KEY, title: 'Arch 2' });

  await page.goto(`/#component/${_ARCH_KEY}`);
  await expect(page.locator(`#dispatch-${arch1.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${arch2.dispatch_id}`)).toBeVisible({ timeout: 5_000 });
});

// ============================================================
// PF-3: navigating to a different component route swaps visible panels
// ============================================================
test('PF-3: navigating between component routes swaps panel visibility', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Arch swap' });
  const nc   = await seedDispatch({ status: 'running', project_key: _NC_KEY,   title: 'NC swap' });

  // Start on architect view
  await page.goto(`/#component/${_ARCH_KEY}`);
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).not.toBeAttached({ timeout: 5_000 });

  // Navigate to neuronic-cloud view — visibility should invert
  await page.evaluate(() => { location.hash = '#component/ticari/neuronic-cloud/main'; });
  await page.waitForTimeout(500);

  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).not.toBeAttached({ timeout: 5_000 });
});

// ============================================================
// PF-4: /agents route shows all panels regardless of project_key
// ============================================================
test('PF-4: agents route shows all panels regardless of project_key', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Agents arch' });
  const nc   = await seedDispatch({ status: 'running', project_key: _NC_KEY,   title: 'Agents nc' });

  await page.goto('/#agents');
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).toBeVisible({ timeout: 5_000 });
});

// ============================================================
// PF-5: home route shows all panels (no project filter)
// ============================================================
test('PF-5: home route shows all panels (no active project filter)', async ({ page }) => {
  const arch = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Home arch' });
  const nc   = await seedDispatch({ status: 'running', project_key: _NC_KEY,   title: 'Home nc' });

  await page.goto('/');
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).toBeVisible({ timeout: 5_000 });
});

// ============================================================
// PF-6: third-project panels are hidden on unrelated component routes
// ============================================================
test('PF-6: panels from a third project are hidden on an unrelated component route', async ({ page }) => {
  // Three projects, only architect is the active route
  const arch  = await seedDispatch({ status: 'running', project_key: _ARCH_KEY, title: 'Third-proj arch' });
  const nc    = await seedDispatch({ status: 'running', project_key: _NC_KEY,   title: 'Third-proj nc' });
  const other = await seedDispatch({ status: 'running', project_key: 'ticari/light-app/main', title: 'Third-proj other' });

  await page.goto(`/#component/${_ARCH_KEY}`);
  await expect(page.locator(`#dispatch-${arch.dispatch_id}`)).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(`#dispatch-${nc.dispatch_id}`)).not.toBeAttached({ timeout: 5_000 });
  await expect(page.locator(`#dispatch-${other.dispatch_id}`)).not.toBeAttached({ timeout: 5_000 });
});
