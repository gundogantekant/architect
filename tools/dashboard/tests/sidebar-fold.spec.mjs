/**
 * Sidebar Fold E2E Tests (SB-1 to SB-5)
 *
 * These tests define the behavioral contract for the sidebar collapse/expand
 * toggle introduced in W-944. The sidebar folds to ~48px when collapsed and
 * expands to ~260px when open. State is persisted to localStorage under the
 * key 'sidebar-collapsed'.
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import { seedTerminal, waitForTerminalLive, waitForTerminalContent } from './helpers.mjs';

test.beforeEach(async ({ page }) => {
  // Clear localStorage only on the FIRST navigation of each test (not on reload),
  // so that tests that set localStorage and then reload can observe persistence.
  // sessionStorage survives page.reload() within the same tab, so we use it as a
  // one-time guard: clear localStorage on first load, skip on subsequent reloads.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('_testInit')) {
      sessionStorage.setItem('_testInit', '1');
      localStorage.clear();
    }
  });
});

test('SB-1: sidebar toggle button exists and is visible on page load', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });
});

test('SB-2: clicking toggle collapses sidebar; clicking again expands it', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });

  // Measure initial width — sidebar should be expanded
  const boxBefore = await page.locator('#sidebar').boundingBox();
  expect(boxBefore.width).toBeGreaterThanOrEqual(240);

  // Click to collapse
  await toggle.click();
  await page.waitForTimeout(300); // allow CSS transition

  const boxCollapsed = await page.locator('#sidebar').boundingBox();
  expect(boxCollapsed.width).toBeLessThan(80);

  // Click again to expand
  await toggle.click();
  await page.waitForTimeout(300);

  const boxExpanded = await page.locator('#sidebar').boundingBox();
  expect(boxExpanded.width).toBeGreaterThanOrEqual(240);
});

test('SB-3: collapsed state persists across page reload', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });

  // Collapse sidebar
  await toggle.click();
  await page.waitForTimeout(300);

  const boxCollapsed = await page.locator('#sidebar').boundingBox();
  expect(boxCollapsed.width).toBeLessThan(80);

  // Reload and assert still collapsed
  await page.reload();
  await page.waitForLoadState('networkidle');

  const boxAfterReload = await page.locator('#sidebar').boundingBox();
  expect(boxAfterReload.width).toBeLessThan(80);
});

test('SB-4: navigation still works from collapsed sidebar', async ({ page }) => {
  await page.goto('/');
  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });

  // Collapse sidebar
  await toggle.click();
  await page.waitForTimeout(300);

  // Navigate via hash change (sidebar nav links use hash routing)
  await page.evaluate(() => { location.hash = '#agents'; });
  await page.waitForTimeout(500);

  // Route change should have taken effect
  const hash = await page.evaluate(() => location.hash);
  expect(hash).toBe('#agents');

  // Main content must have updated — agents view renders #agents-quick-dispatch
  await expect(page.locator('#agents-quick-dispatch')).toBeVisible({ timeout: 5000 });
});

test('SB-5: after expanding a collapsed sidebar with active terminal, xterm terminal container has non-zero dimensions', async ({ page }) => {
  const t = await seedTerminal({ lines: 50, withFakeContent: true, status: 'running' });

  await page.goto('/#agents');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 5);

  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });

  // Collapse then expand
  await toggle.click();
  await page.waitForTimeout(300);
  await toggle.click();
  await page.waitForTimeout(500); // allow xterm refit and resize observer debounce (100ms)

  // After re-expanding, the terminal panel must be visible with non-zero dimensions.
  // We verify via the bounding box of the term-container element (the xterm host div).
  // xterm's FitAddon fires on the ResizeObserver which triggers after the sidebar
  // transition — the terminal adapts its cols/rows to the new container size.
  const termContainer = page.locator(`#term-container-${t.id}`);
  await expect(termContainer).toBeVisible({ timeout: 5000 });

  const box = await termContainer.boundingBox();
  expect(box).not.toBeNull();
  expect(box.width).toBeGreaterThan(0);
  expect(box.height).toBeGreaterThan(0);

  // Also verify xterm itself reports a usable terminal size (cols and rows > 0)
  const termSize = await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) return null;
    return { cols: sess._term.cols, rows: sess._term.rows };
  }, t.id);

  expect(termSize).not.toBeNull();
  expect(termSize.cols).toBeGreaterThan(0);
  expect(termSize.rows).toBeGreaterThan(0);
});

test('SB-6: toggle button stays within visible 48px area at 1440px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const toggle = page.locator('[data-sidebar-toggle]');
  await expect(toggle).toBeVisible({ timeout: 5000 });

  await toggle.click();
  await page.waitForTimeout(300);

  const sidebarBox = await page.locator('#sidebar').boundingBox();
  expect(sidebarBox.width).toBeLessThan(80);

  const toggleBox = await toggle.boundingBox();
  expect(toggleBox).not.toBeNull();
  expect(toggleBox.width).toBeGreaterThan(0);
  expect(toggleBox.x + toggleBox.width).toBeLessThanOrEqual(sidebarBox.x + sidebarBox.width + 1);

  // Must be re-clickable (toggle back)
  await toggle.click();
  await page.waitForTimeout(300);
  const expanded = await page.locator('#sidebar').boundingBox();
  expect(expanded.width).toBeGreaterThanOrEqual(240);
});

test('SB-7: clicking the "Architect" text area (not the icon) also toggles sidebar', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('#sidebar h1');
  await expect(header).toBeVisible({ timeout: 5000 });
  const initial = await page.locator('#sidebar').boundingBox();
  expect(initial.width).toBeGreaterThanOrEqual(240);

  const box = await header.boundingBox();
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
  await page.waitForTimeout(300);

  const collapsed = await page.locator('#sidebar').boundingBox();
  expect(collapsed.width).toBeLessThan(80);
});

test('SB-8: h1 area shows pointer cursor indicating clickability', async ({ page }) => {
  await page.goto('/');
  const header = page.locator('#sidebar h1');
  await expect(header).toBeVisible({ timeout: 5000 });
  const cursor = await header.evaluate(el => getComputedStyle(el).cursor);
  expect(cursor).toBe('pointer');
});
