/**
 * Scroll Wheel E2E Test Suite
 *
 * Tests mouse wheel scroll behaviour in inline and focused terminal modes.
 * Validates that:
 *  - Wheel scroll up preserves position during live data writes (W-1)
 *  - Wheel scroll works in the focus popup (W-2)
 *  - Wheel scroll does not trigger shell history navigation (W-3)
 *  - Scrolling back to bottom re-enables auto-follow (W-4)
 *  - TS-1: SGR mouse wheel sent in alternate screen (scroll up)
 *  - TS-2: SGR mouse wheel sent in alternate screen (scroll down)
 *  - TS-3: Normal screen still uses scrollLines (no SGR sent)
 *  - TS-5: Transition from alternate to normal restores scroll behavior
 *  - TS-6: Wheel count clamped to [1, 10]
 *  - TS-7: Page scroll prevented in all modes
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

// ============================================================
// Alternate Screen Scroll Contracts (TS-*)
// ============================================================

/**
 * Helper: switch xterm to alternate screen buffer and install a
 * wsManager.send interceptor to capture input messages.
 */
async function setupAlternateScreen(page, terminalId) {
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (!sess?._term) throw new Error('session not found');
    // Switch to alternate screen
    sess._term.write('\x1b[?1049h');
    // Intercept wsManager.send to capture input data
    sess._wsManager._sentInputs = [];
    const orig = sess._wsManager.send.bind(sess._wsManager);
    sess._wsManager._origSend = orig;
    sess._wsManager.send = (msg) => {
      if (msg.type === 'input') sess._wsManager._sentInputs.push(msg.data);
      orig(msg);
    };
  }, terminalId);
  await page.waitForTimeout(200);
  // Verify alternate screen is active
  const bufType = await page.evaluate((id) => {
    return window._termSessions?.get(id)?._term?.buffer?.active?.type;
  }, terminalId);
  expect(bufType).toBe('alternate');
}

async function getSentInputs(page, terminalId) {
  return page.evaluate((id) => {
    return window._termSessions?.get(id)?._wsManager?._sentInputs || [];
  }, terminalId);
}

async function clearSentInputs(page, terminalId) {
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (sess?._wsManager) sess._wsManager._sentInputs = [];
  }, terminalId);
}

// TS-1: SGR mouse wheel sent in alternate screen (scroll up)
test('TS-1. SGR mouse wheel sent in alternate screen (scroll up)', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  await setupAlternateScreen(page, t.id);

  // Dispatch wheel event (scroll up)
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -200, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(300);

  const inputs = await getSentInputs(page, t.id);
  expect(inputs.length).toBeGreaterThan(0);
  const sent = inputs.join('');
  // Must contain SGR scroll-up sequences (button 64), NOT arrow keys
  expect(sent).toContain('\x1b[<64;1;1M');
  expect(sent).not.toContain('\x1b[A');
});

// TS-2: SGR mouse wheel sent in alternate screen (scroll down)
test('TS-2. SGR mouse wheel sent in alternate screen (scroll down)', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  await setupAlternateScreen(page, t.id);

  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: +150, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(300);

  const inputs = await getSentInputs(page, t.id);
  expect(inputs.length).toBeGreaterThan(0);
  const sent = inputs.join('');
  // Must contain SGR scroll-down sequences (button 65)
  expect(sent).toContain('\x1b[<65;1;1M');
  expect(sent).not.toContain('\x1b[B');
});

// TS-3: Normal screen still uses scrollLines (no SGR sent)
test('TS-3. Normal screen still uses scrollLines (no SGR sent)', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  // Install interceptor WITHOUT switching to alternate screen
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (sess?._wsManager) {
      sess._wsManager._sentInputs = [];
      const orig = sess._wsManager.send.bind(sess._wsManager);
      sess._wsManager.send = (msg) => {
        if (msg.type === 'input') sess._wsManager._sentInputs.push(msg.data);
        orig(msg);
      };
    }
  }, t.id);

  const metricsBefore = await getXtermScrollMetrics(page, t.id);
  expect(metricsBefore.atBottom).toBe(true);

  // Dispatch wheel event (scroll up) in normal screen
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -200, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(300);

  // Viewport should have scrolled up via scrollLines
  const metricsAfter = await getXtermScrollMetrics(page, t.id);
  expect(metricsAfter.viewportY).toBeLessThan(metricsBefore.baseY);

  // No WebSocket input should have been sent
  const inputs = await getSentInputs(page, t.id);
  expect(inputs.length).toBe(0);
});

// TS-5: Transition from alternate to normal restores scroll behavior
test('TS-5. Transition from alternate to normal restores scroll behavior', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  await setupAlternateScreen(page, t.id);

  // Exit alternate screen
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (sess?._term) sess._term.write('\x1b[?1049l');
  }, t.id);
  await page.waitForTimeout(200);

  const bufType = await page.evaluate((id) => {
    return window._termSessions?.get(id)?._term?.buffer?.active?.type;
  }, t.id);
  expect(bufType).toBe('normal');

  await clearSentInputs(page, t.id);

  // Wheel event should use scrollLines now (normal mode)
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -200, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(300);

  // No SGR sequences should be sent
  const inputs = await getSentInputs(page, t.id);
  expect(inputs.length).toBe(0);

  // Viewport should have scrolled
  const metrics = await getXtermScrollMetrics(page, t.id);
  expect(metrics.viewportY).toBeLessThan(metrics.baseY);
});

// TS-6: Wheel count clamped to [1, 10]
test('TS-6. Wheel count clamped to [1, 10]', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  await setupAlternateScreen(page, t.id);

  // Send a very large deltaY (fast trackpad gesture)
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -5000, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(300);

  const inputs = await getSentInputs(page, t.id);
  const sent = inputs.join('');
  // SGR scroll-up sequence is 11 chars: \x1b[<64;1;1M
  // Count occurrences — should be exactly 10 (clamped)
  const matches = sent.match(/\x1b\[<64;1;1M/g) || [];
  expect(matches.length).toBe(10);
});

// TS-7: Page scroll prevented in all modes
test('TS-7. Page scroll prevented in all modes', async ({ page }) => {
  test.setTimeout(90_000);
  const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

  await setupAlternateScreen(page, t.id);

  const scrollBefore = await page.evaluate(() => window.scrollY);

  // Wheel event in alternate screen
  await page.evaluate(({ id }) => {
    const container = document.getElementById(`term-container-${id}`);
    container.dispatchEvent(new WheelEvent('wheel', {
      deltaY: -500, bubbles: true, cancelable: true, composed: true,
    }));
  }, { id: t.id });
  await page.waitForTimeout(200);

  const scrollAfter = await page.evaluate(() => window.scrollY);
  expect(scrollAfter).toBe(scrollBefore);
});
