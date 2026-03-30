/**
 * Phase 0: Route Navigation Tests
 *
 * These tests guard against xterm.js panel lifecycle regressions during route changes.
 * They test EXISTING behavior — must pass on unmodified code.
 * If any fail, the bug must be investigated before the W-128 refactor proceeds.
 */

import { test, expect } from './fixtures.mjs';
import {
  purgeAll,
  seedTerminal,
  seedDispatch,
  waitForTerminalLive,
  getXtermScrollMetrics,
  waitForTerminalContent,
} from './helpers.mjs';

const getTestBase = () => `http://127.0.0.1:${process.env.TEST_SERVER_PORT || 3778}`;

test.beforeEach(async () => { await purgeAll(); });

test('R-NAV-1: navigate away while terminal LIVE, back, xterm content intact and state LIVE', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { terminal_id: id } = await seedTerminal({ withFakeContent: true, lines: 200 });
  await page.goto('/');
  await waitForTerminalLive(page, id, 20_000);
  await waitForTerminalContent(page, id, 30);

  // Wait explicitly for scrollback to accumulate (baseY > 0 confirms content exceeds viewport)
  await page.waitForFunction(
    (id) => (window._termSessions?.get(id)?._term?.buffer?.active?.baseY ?? 0) > 0,
    id,
    { timeout: 10_000 },
  );

  const metricsBefore = await getXtermScrollMetrics(page, id);
  expect(metricsBefore.baseY).toBeGreaterThan(0);

  // Navigate away
  await page.evaluate(() => { location.hash = '#agents'; });
  await page.waitForTimeout(500);

  // Navigate back
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(500);

  // Panel must be present and have content
  await expect(page.locator(`#terminal-${id}`)).toBeVisible();
  const metricsAfter = await getXtermScrollMetrics(page, id);
  expect(metricsAfter.baseY).toBeGreaterThan(0);

  // State must be LIVE or EXITED (not DISCONNECTED — connection survived)
  const state = await page.evaluate((id) => window._termSessions?.get(id)?.state, id);
  expect(['LIVE', 'EXITED', 'REPLAYING']).toContain(state);
});

test('R-NAV-2: navigate away while dispatch panel present, back, panel still in DOM', async ({ page }) => {
  const dispatchId = `D-nav-test-${Date.now()}`;
  await seedDispatch({ id: dispatchId, status: 'running', title: 'Nav test dispatch' });
  await page.goto('/');
  await expect(page.locator(`#dispatch-${dispatchId}`)).toBeVisible({ timeout: 5000 });

  // Navigate away
  await page.evaluate(() => { location.hash = '#epics'; });
  await page.waitForTimeout(500);

  // Navigate back
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(500);

  // Dispatch panel must still be present
  await expect(page.locator(`#dispatch-${dispatchId}`)).toBeVisible();
});

test('R-NAV-3: navigate #settings then back, terminal FitAddon re-fires and cols > 80', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const { terminal_id: id } = await seedTerminal({ withFakeContent: true, lines: 20 });
  await page.goto('/');
  await waitForTerminalLive(page, id, 20_000);

  // Navigate to settings
  await page.evaluate(() => { location.hash = '#settings'; });
  await page.waitForTimeout(500);

  // Navigate back
  await page.evaluate(() => { location.hash = ''; });
  await page.waitForTimeout(800); // allow rAF to fire fitPreservingScroll

  const cols = await page.evaluate((id) => window._termSessions?.get(id)?._term?.cols, id);
  expect(cols).toBeGreaterThan(80);
});
