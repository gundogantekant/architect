/**
 * Text Selection E2E Test Suite
 *
 * Tests that text selection works correctly in dispatch and terminal panels.
 * Validates that:
 *  - TS-1: Text selection preserved while content streams into dispatch log
 *  - TS-2: Page scroll position unchanged when dispatch log receives data
 *  - TS-3: Auto-scroll resumes after selection is cleared in dispatch log
 *  - TS-4: Terminal click after xterm selection does NOT trigger scrollToBottom
 *
 * Uses programmatic Selection API (not mouse drag) for headless reliability.
 */

import { test, expect } from './fixtures.mjs';
import {
  getBase,
  seedDispatch,
  seedTerminal,
  getDispatchLogScrollMetrics,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermScrollMetrics,
  scrollTerminalWheel,
} from './helpers.mjs';

const SEED_LINES = 100;

function makeOutputLines(count, prefix = 'Plan') {
  return Array.from({ length: count }, (_, i) => `${prefix} line ${i}: ${'x'.repeat(60)}\n`);
}

function localApi(path, opts = {}) {
  const workerIdx = process.env.TEST_WORKER_INDEX;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (workerIdx !== undefined) headers['x-test-worker-id'] = String(workerIdx);
  return fetch(`${getBase()}/${path.replace(/^\//, '')}`, { ...opts, headers }).then(r => r.json());
}

async function appendDispatchOutput(id, lines) {
  const jsonLines = lines.map(text =>
    JSON.stringify({ type: 'content_block_delta', delta: { text } })
  );
  return localApi('api/test/append-dispatch-output', {
    method: 'POST',
    body: JSON.stringify({ id, lines: jsonLines }),
  });
}

async function waitForDispatchLogReady(page, id, timeout = 20_000) {
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      if (!el || el.clientHeight === 0) return false;
      return el.scrollHeight > el.clientHeight && el.dataset.replayDone === '1';
    },
    id,
    { timeout, polling: 200 },
  );
  await page.waitForTimeout(100);
}

// ============================================================
// TS-1: Text selection preserved while content streams in
// ============================================================

test('TS-1. Text selection preserved while content streams in', async ({ page }) => {
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto(`${getBase()}/#agents`);
  await waitForDispatchLogReady(page, id);

  // Scroll to top of dispatch log so we're not near bottom
  await page.evaluate((id) => {
    document.getElementById(`log-${id}`).scrollTop = 0;
  }, id);
  await page.waitForTimeout(100);

  // Create a programmatic text selection on the 3rd text node in the log
  const selectedText = await page.evaluate((id) => {
    const logEl = document.getElementById(`log-${id}`);
    const textNodes = [];
    const walker = document.createTreeWalker(logEl, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) textNodes.push(node);
    if (textNodes.length < 3) return null;

    const target = textNodes[2];
    const range = document.createRange();
    range.setStart(target, 0);
    range.setEnd(target, Math.min(20, target.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    return sel.toString();
  }, id);

  expect(selectedText).toBeTruthy();

  // Append new lines while selection is active
  await appendDispatchOutput(id, makeOutputLines(15, 'Stream'));
  await page.waitForTimeout(500);

  // Assert selection is still intact
  const afterSelection = await page.evaluate(() => {
    const sel = window.getSelection();
    return {
      isCollapsed: sel.isCollapsed,
      text: sel.toString(),
      type: sel.type,
    };
  });

  expect(afterSelection.isCollapsed).toBe(false);
  expect(afterSelection.text).toBe(selectedText);
  expect(afterSelection.type).toBe('Range');

  // Verify new content arrived
  const logText = await page.evaluate((id) => {
    return document.getElementById(`log-${id}`).textContent;
  }, id);
  expect(logText).toContain('Stream line 14');
});

// ============================================================
// TS-2: Page scroll position unchanged when dispatch log receives data
// ============================================================

test('TS-2. Page scroll position unchanged when dispatch log receives data', async ({ page }) => {
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto(`${getBase()}/#agents`);
  await waitForDispatchLogReady(page, id);

  // Capture #main scrollTop before appending
  const scrollBefore = await page.evaluate(() => {
    const main = document.getElementById('main');
    return main ? main.scrollTop : document.documentElement.scrollTop;
  });

  // Append 20 lines
  await appendDispatchOutput(id, makeOutputLines(20, 'Anchor'));
  await page.waitForTimeout(500);

  // Assert page scroll position unchanged
  const scrollAfter = await page.evaluate(() => {
    const main = document.getElementById('main');
    return main ? main.scrollTop : document.documentElement.scrollTop;
  });

  expect(Math.abs(scrollAfter - scrollBefore)).toBeLessThan(5);
});

// ============================================================
// TS-3: Auto-scroll resumes after selection is cleared
// ============================================================

test('TS-3. Auto-scroll resumes after selection is cleared', async ({ page }) => {
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto(`${getBase()}/#agents`);
  await waitForDispatchLogReady(page, id);

  // Scroll to bottom of dispatch log
  await page.evaluate((id) => {
    const logEl = document.getElementById(`log-${id}`);
    logEl.scrollTop = logEl.scrollHeight;
  }, id);
  await page.waitForTimeout(100);

  // Create selection
  await page.evaluate((id) => {
    const logEl = document.getElementById(`log-${id}`);
    const walker = document.createTreeWalker(logEl, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    if (!node) return;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(10, node.textContent.length));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, id);

  // Append lines while selected — auto-scroll should be suppressed
  await appendDispatchOutput(id, makeOutputLines(5, 'Sel'));
  await page.waitForTimeout(300);

  // Clear selection
  await page.evaluate(() => window.getSelection().removeAllRanges());
  await page.waitForTimeout(100);

  // Scroll back to bottom explicitly (selection suppressed auto-scroll)
  await page.evaluate((id) => {
    const logEl = document.getElementById(`log-${id}`);
    logEl.scrollTop = logEl.scrollHeight;
  }, id);
  await page.waitForTimeout(100);

  // Append more lines — auto-scroll should now resume
  await appendDispatchOutput(id, makeOutputLines(5, 'Resume'));
  await page.waitForTimeout(500);

  const metrics = await getDispatchLogScrollMetrics(page, id);
  expect(metrics.atBottom).toBe(true);

  // Verify new content present
  const logText = await page.evaluate((id) => {
    return document.getElementById(`log-${id}`).textContent;
  }, id);
  expect(logText).toContain('Resume line 4');
});

// ============================================================
// TS-4: Terminal click after xterm selection does NOT trigger scrollToBottom
// ============================================================

test('TS-4. Terminal click after xterm selection does NOT trigger scrollToBottom', async ({ page }) => {
  test.setTimeout(60_000);

  const t = await seedTerminal({ lines: 300, withFakeContent: true, status: 'running' });
  const termId = t.id;

  await page.goto(`${getBase()}/#agents`);
  await waitForTerminalLive(page, termId);
  await waitForTerminalContent(page, termId, 10);

  // Scroll up from bottom
  await scrollTerminalWheel(page, termId, -500, 5);
  await page.waitForTimeout(200);

  const metricsBefore = await getXtermScrollMetrics(page, termId);
  expect(metricsBefore.atBottom).toBe(false);

  // Create selection using xterm's internal API (not browser Selection API)
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    if (sess?._term) {
      sess._term.selectAll();
    }
  }, termId);
  await page.waitForTimeout(100);

  // Verify xterm has a selection
  const hasSelection = await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    return sess?._term?.hasSelection() || false;
  }, termId);
  expect(hasSelection).toBe(true);

  // Dispatch a click event on the terminal container
  await page.evaluate((id) => {
    const container = document.getElementById(`term-container-${id}`);
    if (container) {
      container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
  }, termId);
  await page.waitForTimeout(200);

  // Assert scroll position unchanged (did NOT scroll to bottom)
  const metricsAfter = await getXtermScrollMetrics(page, termId);
  expect(metricsAfter.atBottom).toBe(false);
  expect(Math.abs(metricsAfter.viewportY - metricsBefore.viewportY)).toBeLessThan(3);
});
