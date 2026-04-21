/**
 * Auto-Dismiss Tests (W-843)
 *
 * Verifies that dispatch and terminal panels auto-dismiss ~8 seconds after
 * the session exits (completed, failed, killed). Suspended sessions must NOT
 * auto-dismiss. Hover pauses the countdown.
 */

import { test as baseTest, expect } from './fixtures.mjs';
import { getBase, seedDispatch, seedTerminal } from './helpers.mjs';

// Override the _disableAutoDismiss fixture — these tests need auto-dismiss active
const test = baseTest.extend({
  _disableAutoDismiss: [async ({}, use) => { await use(); }, { scope: 'test', auto: true }],
});

const AUTO_DISMISS_MS = 8000;
const MARGIN_MS = 6000; // extra margin for CI/slow environments

test.beforeAll(async () => {
  await fetch(`${getBase()}/api/test/purge-all`, { method: 'POST' });
});

// ============================================================
// Suite: Auto-Dismiss (AD-1 to AD-7)
// ============================================================

test('AD-1: completed dispatch panel auto-dismisses after ~8s', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Panel should be removed from DOM within 8s + margin
  await page.waitForSelector(`#dispatch-${id}`, {
    state: 'detached',
    timeout: AUTO_DISMISS_MS + MARGIN_MS,
  });
});

test('AD-2: killed dispatch panel auto-dismisses after ~8s', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Kill the dispatch
  await page.locator(`[data-kill-dispatch="${id}"]`).click();
  await expect(page.locator(`#dispatch-${id}`)).toHaveClass(/status-killed/, { timeout: 5000 });

  // Should auto-dismiss
  await page.waitForSelector(`#dispatch-${id}`, {
    state: 'detached',
    timeout: AUTO_DISMISS_MS + MARGIN_MS,
  });
});

test('AD-3: completed terminal panel auto-dismisses after ~8s', async ({ page }) => {
  const { id } = await seedTerminal({ status: 'completed', withFakeContent: true, lines: 5 });
  await page.goto('/');
  await expect(page.locator(`#terminal-${id}`)).toBeVisible({ timeout: 5000 });

  await page.waitForSelector(`#terminal-${id}`, {
    state: 'detached',
    timeout: AUTO_DISMISS_MS + MARGIN_MS,
  });
});

test('AD-4: countdown bar appears on finalized dispatch panel', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // The countdown bar should be present in the DOM (may be clipped when panel is collapsed)
  await expect(page.locator(`#dispatch-${id} .auto-dismiss-bar`)).toBeAttached({ timeout: 3000 });
});

test('AD-5: hover pauses auto-dismiss — panel survives beyond 8s', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto('/');
  const panel = page.locator(`#dispatch-${id}`);
  await expect(panel).toBeVisible({ timeout: 5000 });

  // Hover over the panel to pause the timer
  await panel.hover();

  // Wait longer than the auto-dismiss timeout while hovering
  await page.waitForTimeout(AUTO_DISMISS_MS + 2000);

  // Panel should still be visible because hover paused the timer
  await expect(panel).toBeVisible();

  // Move mouse away to resume the timer
  await page.mouse.move(0, 0);

  // Now it should auto-dismiss within the remaining time
  await page.waitForSelector(`#dispatch-${id}`, {
    state: 'detached',
    timeout: AUTO_DISMISS_MS + MARGIN_MS,
  });
});

test('AD-6: manual dismiss before timer fires works without error', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'completed' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Dismiss manually via the button
  const dismissBtn = page.locator(`[data-dismiss-dispatch="${id}"]`);
  await expect(dismissBtn).toBeVisible({ timeout: 3000 });
  await dismissBtn.click();

  // Panel should be gone immediately
  await expect(page.locator(`#dispatch-${id}`)).not.toBeVisible({ timeout: 3000 });

  // Wait past the auto-dismiss window — panel must not reappear
  await page.waitForTimeout(AUTO_DISMISS_MS + 2000);
  await expect(page.locator(`#dispatch-${id}`)).not.toBeVisible();
});

test('AD-7: suspended dispatch does NOT auto-dismiss', async ({ page }) => {
  const { dispatch_id: id } = await seedDispatch({ status: 'suspended' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Wait well beyond the auto-dismiss timeout
  await page.waitForTimeout(AUTO_DISMISS_MS + 3000);

  // Panel should still be visible
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible();

  // No countdown bar should be present
  await expect(page.locator(`#dispatch-${id} .auto-dismiss-bar`)).not.toBeVisible();
});
