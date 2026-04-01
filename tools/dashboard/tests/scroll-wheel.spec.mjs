/**
 * Scroll Wheel E2E Test Suite
 *
 * Tests mouse wheel scroll behaviour in inline and focused terminal modes.
 * Validates that:
 *  - Wheel scroll up preserves position during live data writes (W-1)
 *  - Wheel scroll works in the focus popup (W-2)
 *  - Wheel scroll does not trigger shell history navigation (W-3)
 *  - Scrolling back to bottom re-enables auto-follow (W-4)
 *
 * Tests run against an isolated test server started automatically by globalSetup.
 */

import { test, expect } from './fixtures.mjs';
import {
  getBase,
  seedTerminal,
  pumpTerminal,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermScrollMetrics,
  getXtermBufferLines,
  waitForEventQueueDrain,
  pumpAndWait,
  scrollTerminalWheel,
  waitForShellReady,
  waitForTextInXterm,
} from './helpers.mjs';

const SEED_LINES = 500;
const SEED_MIN = 400;

// ============================================================
// W-1: Wheel scroll up preserves position during live pump
// ============================================================

test('W-1. Wheel scroll up preserves position during live pump', async ({ page }) => {
  // Failure mode: term.write() auto-scrolls to bottom, pushing the user
  // back down even though they explicitly scrolled up with the mouse wheel.
  test.setTimeout(90_000);

  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  // Verify we start at the bottom
  const metricsBefore = await getXtermScrollMetrics(page, t.id);
  expect(metricsBefore.atBottom).toBe(true);

  // Scroll up with mouse wheel (negative deltaY = scroll up)
  await scrollTerminalWheel(page, t.id, -300, 5);
  await page.waitForTimeout(300);

  const metricsAfterScroll = await getXtermScrollMetrics(page, t.id);
  expect(metricsAfterScroll.atBottom).toBe(false);
  const viewportAfterScroll = metricsAfterScroll.viewportY;

  // Pump 50 more lines while user is scrolled up
  await pumpTerminal(t.id, { linesPerSecond: 10, duration: 5 });
  await page.waitForTimeout(6000);

  // User must still be scrolled up — not forced back to bottom
  const metricsAfterPump = await getXtermScrollMetrics(page, t.id);
  expect(metricsAfterPump.atBottom).toBe(false);
  // viewportY should be close to where the user scrolled (may shift slightly due to baseY growth)
  expect(metricsAfterPump.viewportY).toBeLessThanOrEqual(viewportAfterScroll + 5);
});

// ============================================================
// W-2: Wheel scroll in focused mode works
// ============================================================

test('W-2. Wheel scroll in focused mode works', async ({ page }) => {
  // Failure mode: focus popup intercepts or blocks wheel events, preventing
  // xterm scrollback navigation in fullscreen mode.
  test.setTimeout(90_000);

  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  // Open focus popup (there are top and bottom focus buttons — use first)
  const focusBtn = page.locator(`#terminal-${t.id} .focus-btn`).first();
  await focusBtn.click();
  await page.waitForTimeout(500);

  // Verify focus popup is visible
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5000 });

  // The terminal container is now inside the focus popup — get its new bounding box
  const focusBody = page.locator('.focus-popup-body');
  const box = await focusBody.boundingBox();
  expect(box).not.toBeNull();

  // Move mouse into the focus popup and scroll up
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, -300);
  await page.mouse.wheel(0, -300);
  await page.waitForTimeout(500);

  // Verify scroll position moved up
  const metrics = await getXtermScrollMetrics(page, t.id);
  expect(metrics.atBottom).toBe(false);
  expect(metrics.viewportY).toBeLessThan(metrics.baseY);
});

// ============================================================
// W-3: Wheel scroll does not trigger shell history navigation
// ============================================================

test('W-3. Wheel scroll does not trigger shell history navigation', async ({ page }) => {
  // Failure mode: xterm translates wheel events to escape sequences (arrow
  // up/down) when shell enables mouse reporting. This causes zsh to cycle
  // through command history instead of scrolling the scrollback buffer.
  test.setTimeout(90_000);

  // Spawn a real shell terminal via the real terminal API endpoint
  const workerIdx = process.env.TEST_WORKER_INDEX;
  const resp = await fetch(`${getBase()}/api/terminal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
    },
    body: JSON.stringify({
      project_key: '\u2013/architect/\u2013',
      title: 'wheel-history-test',
      agentType: 'shell',
      permission_mode: 'acceptEdits',
      skip_seed: true,
    }),
  });
  const { terminal_id } = await resp.json();

  await page.goto('/#terminals');
  await waitForShellReady(page, terminal_id, 20_000);

  // Send input via WebSocket (more reliable than keyboard under load)
  const sendInput = (text) => page.evaluate(({ id, t }) => {
    const sess = window._termSessions?.get(id);
    if (sess?._wsManager) sess._wsManager.send({ type: 'input', data: t });
  }, { id: terminal_id, t: text });

  // Type two commands to build shell history
  await sendInput('echo SCROLL_TEST_LINE_1\n');
  await waitForTextInXterm(page, terminal_id, 'SCROLL_TEST_LINE_1', 10_000);

  await sendInput('echo SCROLL_TEST_LINE_2\n');
  await waitForTextInXterm(page, terminal_id, 'SCROLL_TEST_LINE_2', 10_000);

  // Generate enough output for scrollback — use individual echo commands
  // sent line-by-line to ensure each one gets through the PTY and into xterm's buffer.
  // Send one large block with newlines to ensure scrollback is created.
  await sendInput('seq 1 500\n');
  await waitForTextInXterm(page, terminal_id, '500', 15_000);

  // Wait for xterm buffer to have scrollback (baseY > 0)
  await page.waitForFunction((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) return false;
    return sess._term.buffer.active.baseY > 0;
  }, terminal_id, { timeout: 15_000 });

  // Wait for terminal to fully stabilize — baseY must stop changing for 1500ms.
  // After `seq 1 500` the shell writes its prompt and xterm may still be rendering
  // buffered output. If we scroll before all PTY data is flushed, xterm auto-scrolls
  // to bottom on the next write, undoing our scroll.
  await page.waitForFunction((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) return false;
    const baseY = sess._term.buffer.active.baseY;
    if (baseY !== window.__w3_lastBaseY) {
      window.__w3_lastBaseY = baseY;
      window.__w3_stableAt = Date.now();
      return false;
    }
    return Date.now() - (window.__w3_stableAt || 0) > 1500;
  }, terminal_id, { timeout: 30_000, polling: 100 });

  // Capture buffer state before wheel scroll
  const metricsBefore = await getXtermScrollMetrics(page, terminal_id);
  expect(metricsBefore.baseY).toBeGreaterThan(0);
  const lineCountBefore = metricsBefore.baseY + metricsBefore.rows;

  // Dispatch wheel events via JS rather than Playwright's page.mouse.wheel().
  // Chromium's compositor consumes CDP-dispatched wheel events on xterm's
  // scrollable .xterm-viewport before they become DOM WheelEvents, so our
  // capture-phase handler on containerEl never fires. JS-dispatched events
  // go through the full DOM capture/bubble cycle and are intercepted correctly.
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    for (let i = 0; i < 5; i++) {
      container.dispatchEvent(new WheelEvent('wheel', {
        deltaY: -200, bubbles: true, cancelable: true, composed: true,
      }));
    }
  }, { id: terminal_id });
  await page.waitForTimeout(500);

  const metricsAfter = await getXtermScrollMetrics(page, terminal_id);

  // Verify scroll moved up
  expect(metricsAfter.viewportY).toBeLessThan(metricsBefore.baseY);

  // The buffer should NOT have grown significantly — no new commands were executed.
  // If wheel triggered history navigation (arrow up), zsh would show a previous
  // command in the prompt which might accidentally execute or add buffer lines.
  const lineCountAfter = metricsAfter.baseY + metricsAfter.rows;
  expect(lineCountAfter).toBeLessThanOrEqual(lineCountBefore + 3);
});

// ============================================================
// W-4: Scroll back to bottom re-enables auto-follow
// ============================================================

test('W-4. Scroll back to bottom re-enables auto-follow', async ({ page }) => {
  // Failure mode: after scrolling up and back to bottom, the auto-follow
  // flag stays false and new content doesn't auto-scroll.
  test.setTimeout(90_000);

  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  // Use programmatic scroll to go up (wheel scroll is the bug we're testing in W-1)
  await page.evaluate((id) => {
    const term = window._termSessions?.get(id)?._term;
    if (term) term.scrollToTop();
  }, t.id);
  await page.waitForTimeout(300);

  const metricsUp = await getXtermScrollMetrics(page, t.id);
  expect(metricsUp.atBottom).toBe(false);

  // Scroll back to bottom
  await page.evaluate((id) => {
    const term = window._termSessions?.get(id)?._term;
    if (term) term.scrollToBottom();
  }, t.id);
  await page.waitForTimeout(200);

  const metricsBottom = await getXtermScrollMetrics(page, t.id);
  expect(metricsBottom.atBottom).toBe(true);

  // Pump more data — terminal should follow (stay at bottom)
  await pumpAndWait(page, t.id, { linesPerSecond: 10, duration: 3 });

  const metricsAfterPump = await getXtermScrollMetrics(page, t.id);
  expect(metricsAfterPump.atBottom).toBe(true);
});
