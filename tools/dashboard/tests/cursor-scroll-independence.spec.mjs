/**
 * Cursor/Scroll Independence E2E Tests
 *
 * Invariant: scroll operations change viewportY only, never the cursor's
 * absolute buffer position. Typing while scrolled up must NOT snap the
 * viewport back to the cursor. Clicking must snap the viewport to the cursor.
 *
 *  C-1: Scrolling does NOT move the cursor in the buffer
 *  C-2: Typing while scrolled up does NOT snap viewport to cursor  [pre-fix: FAILS]
 *  C-3: Typing at the bottom keeps auto-follow intact              [regression guard]
 *  C-4: Clicking while scrolled up snaps viewport to cursor        [pre-fix: FAILS]
 *  C-5: Cursor absoluteY is always within active screen bounds
 *
 * C-2 and C-4 fail before the fix (scrollOnUserInput: false + click handler).
 */

import { test, expect } from './fixtures.mjs';
import {
  seedTerminal,
  waitForTerminalLive,
  waitForTerminalContent,
  waitForShellReady,
  getXtermScrollMetrics,
  getXtermCursorPosition,
  scrollTerminalWheel,
  getBase,
} from './helpers.mjs';

// ── helpers ────────────────────────────────────────────────────────────────

function makeShellTerminal() {
  const workerIdx = process.env.TEST_WORKER_INDEX;
  return fetch(`${getBase()}/api/terminal`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
    },
    body: JSON.stringify({
      project_key: '\u2013/architect/\u2013',
      agentType: 'shell',
      permission_mode: 'acceptEdits',
      skip_seed: true,
    }),
  }).then((r) => r.json()).then((d) => d.terminal_id);
}

const sendInput = (page, id, text) => page.evaluate(({ id, t }) => {
  const sess = window._termSessions?.get(id);
  if (sess?._wsManager) sess._wsManager.send({ type: 'input', data: t });
}, { id, t: text });

async function scrollToFraction(page, id, fraction) {
  await page.evaluate(({ id, f }) => {
    const term = window._termSessions?.get(id)?._term;
    if (!term) return;
    const buf = term.buffer.active;
    const target = Math.round(buf.baseY * f);
    term.scrollLines(target - buf.viewportY);
  }, { id, f: fraction });
  await page.waitForTimeout(150);
}

// ── C-1 ───────────────────────────────────────────────────────────────────

test('C-1. Scroll does not change cursor buffer position', async ({ page }) => {
  test.setTimeout(90_000);

  const t = await seedTerminal({ withFakeContent: true, lines: 500 });

  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 400, 60_000);

  const cursorBefore = await getXtermCursorPosition(page, t.id);
  expect(cursorBefore).not.toBeNull();

  // Scroll up
  await scrollTerminalWheel(page, t.id, -300, 5);
  await page.waitForTimeout(300);

  const metricsMid = await getXtermScrollMetrics(page, t.id);
  expect(metricsMid.atBottom).toBe(false);

  const cursorMid = await getXtermCursorPosition(page, t.id);
  expect(cursorMid.absoluteY).toBe(cursorBefore.absoluteY);
  expect(cursorMid.cursorX).toBe(cursorBefore.cursorX);

  // Scroll back down
  await scrollTerminalWheel(page, t.id, 300, 5);
  await page.waitForTimeout(300);

  const cursorAfter = await getXtermCursorPosition(page, t.id);
  expect(cursorAfter.absoluteY).toBe(cursorBefore.absoluteY);
  expect(cursorAfter.cursorX).toBe(cursorBefore.cursorX);
});

// ── C-2 ───────────────────────────────────────────────────────────────────

test('C-2. Typing while scrolled up does not snap viewport to cursor', async ({ page }) => {
  // This is the PRIMARY regression test for scrollOnUserInput: false.
  //
  // Pre-fix (scrollOnUserInput: true, xterm default):
  //   xterm calls scrollToBottom() internally before processing every
  //   keyboard event that triggers onData. This snaps the viewport from
  //   the user's reading position back to the cursor position — the user
  //   experiences this as the cursor "jumping into history."
  //
  // Post-fix (scrollOnUserInput: false):
  //   Keyboard events reach xterm without triggering any viewport scroll.
  //
  // Key: we use real page.keyboard input so the event travels through xterm's
  // DOM keyboard handler (which is where scrollOnUserInput fires). Sending
  // via WebSocket bypasses this path entirely and would not catch the bug.
  test.setTimeout(90_000);

  const t = await seedTerminal({ withFakeContent: true, lines: 500 });
  await page.goto('/#terminals');
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 400, 60_000);

  // Scroll to ~50%
  await scrollToFraction(page, t.id, 0.5);
  const scrolled = await getXtermScrollMetrics(page, t.id);
  expect(scrolled.atBottom).toBe(false);
  const savedViewportY = scrolled.viewportY;

  // Focus the terminal then press a real key — triggers xterm's scrollOnUserInput path
  await page.evaluate((id) => {
    const term = window._termSessions?.get(id)?._term;
    if (term) term.focus();
  }, t.id);
  await page.keyboard.press('a');
  await page.waitForTimeout(200);

  // PRIMARY ASSERTION: viewport must NOT have snapped to the cursor (bottom)
  const afterOne = await getXtermScrollMetrics(page, t.id);
  expect(afterOne.atBottom).toBe(false);
  expect(afterOne.viewportY).toBeGreaterThanOrEqual(savedViewportY - 3);

  // Multiple keystrokes must also be stable
  for (const key of ['b', 'c', 'd', 'e']) {
    await page.keyboard.press(key);
  }
  await page.waitForTimeout(200);

  const afterMore = await getXtermScrollMetrics(page, t.id);
  expect(afterMore.atBottom).toBe(false);
  expect(afterMore.viewportY).toBeGreaterThanOrEqual(savedViewportY - 3);
});

// ── C-3 ───────────────────────────────────────────────────────────────────

test('C-3. Typing at bottom keeps auto-follow intact', async ({ page }) => {
  // Regression guard: scrollOnUserInput: false must not break the common
  // workflow where the user is already at the bottom and types.
  test.setTimeout(90_000);

  const id = await makeShellTerminal();
  await page.goto('/#terminals');
  await waitForShellReady(page, id, 20_000);

  const start = await getXtermScrollMetrics(page, id);
  expect(start.atBottom).toBe(true);

  await sendInput(page, id, 'echo CURSOR_BOTTOM_TEST\n');
  await page.waitForTimeout(600);

  const afterEcho = await getXtermScrollMetrics(page, id);
  expect(afterEcho.atBottom).toBe(true);

  await sendInput(page, id, 'seq 1 80\n');
  await page.waitForTimeout(2500);

  const afterSeq = await getXtermScrollMetrics(page, id);
  expect(afterSeq.atBottom).toBe(true);
});

// ── C-4 ───────────────────────────────────────────────────────────────────

test('C-4. Clicking while scrolled up snaps viewport to cursor', async ({ page }) => {
  // Clicking in the terminal is the intentional gesture to return to the
  // input area. Pre-fix: no click handler exists, so clicking has no effect
  // on the scroll position.
  test.setTimeout(90_000);

  const id = await makeShellTerminal();
  await page.goto('/#terminals');
  await waitForShellReady(page, id, 20_000);

  await sendInput(page, id, 'seq 1 400\n');
  await page.waitForFunction((id) => {
    const sess = window._termSessions?.get(id);
    return sess?._term?.buffer.active.baseY > 0;
  }, id, { timeout: 20_000 });

  // Scroll to ~50%
  await scrollToFraction(page, id, 0.5);
  const scrolled = await getXtermScrollMetrics(page, id);
  expect(scrolled.atBottom).toBe(false);

  // Dispatch a click event on the terminal container
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    const containerEl = sess?._term?.element?.closest?.('.terminal-container')
      ?? document.getElementById(`term-container-${id}`);
    if (containerEl) {
      containerEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }, id);
  await page.waitForTimeout(300);

  const afterClick = await getXtermScrollMetrics(page, id);
  expect(afterClick.atBottom).toBe(true);
});

// ── C-5 ───────────────────────────────────────────────────────────────────

test('C-5. Cursor absoluteY stays within active screen bounds after scrolling', async ({ page }) => {
  // Invariant: cursor is always on the active screen (baseY..baseY+rows-1).
  // Scroll operations change viewportY but must never change baseY or cursorY
  // in a way that puts the cursor in the scrollback history region.
  test.setTimeout(90_000);

  const id = await makeShellTerminal();
  await page.goto('/#terminals');
  await waitForShellReady(page, id, 20_000);

  await sendInput(page, id, 'seq 1 300\n');
  await page.waitForFunction((id) => {
    const sess = window._termSessions?.get(id);
    return sess?._term?.buffer.active.baseY > 0;
  }, id, { timeout: 20_000 });

  // Perform many scroll operations and check invariant each time
  const fractions = [0.8, 0.5, 0.2, 0.0, 0.6, 1.0];
  for (const f of fractions) {
    await scrollToFraction(page, id, f);
    const metrics = await getXtermScrollMetrics(page, id);
    const cursor = await getXtermCursorPosition(page, id);
    expect(cursor).not.toBeNull();
    // Cursor must be within the active screen (not in scrollback history)
    expect(cursor.absoluteY).toBeGreaterThanOrEqual(metrics.baseY);
    expect(cursor.absoluteY).toBeLessThan(metrics.baseY + metrics.rows);
  }
});
