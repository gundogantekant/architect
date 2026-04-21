/**
 * Dispatch Scroll E2E Test Suite
 *
 * Tests scroll behaviour in dispatch log panels (plain DOM div, not xterm.js).
 * Validates that:
 *  - DS-1: Small scroll up near bottom disengages auto-follow
 *  - DS-2: Scroll position preserved while new data streams in (far scroll)
 *  - DS-3: Auto-scroll resumes when user returns to bottom
 *  - DS-4: Scrollbar appears when dispatch content exceeds inline container height
 *  - DS-5: Scrollbar appears in focus popup with long content
 *  - DS-6: Continuous rapid streaming preserves scroll position
 *  - DS-7: Scrollbar appears in work-item session slot (200px container)
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import {
  getBase,
  seedDispatch,
  seedWorkItem,
  getDispatchLogScrollMetrics,
} from './helpers.mjs';

const SEED_LINES = 100;

function makeOutputLines(count, prefix = 'Plan') {
  return Array.from({ length: count }, (_, i) => `${prefix} line ${i}: ${'x'.repeat(60)}`);
}

function api(path, opts = {}) {
  const workerIdx = process.env.TEST_WORKER_INDEX;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (workerIdx !== undefined) headers['x-test-worker-id'] = String(workerIdx);
  return fetch(`${getBase()}/${path.replace(/^\//, '')}`, { ...opts, headers }).then(r => r.json());
}

async function appendDispatchOutput(id, lines) {
  const jsonLines = lines.map(text =>
    JSON.stringify({ type: 'content_block_delta', delta: { text: text + '\n' } })
  );
  return api('api/test/append-dispatch-output', {
    method: 'POST',
    body: JSON.stringify({ id, lines: jsonLines }),
  });
}

/** Wait for dispatch log to have scrollable content and replay to be done. */
async function waitForDispatchLogReady(page, id, timeout = 20_000) {
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      if (!el || el.clientHeight === 0) return false;
      // Content must overflow AND replay-done marker must be set
      return el.scrollHeight > el.clientHeight && el.dataset.replayDone === '1';
    },
    id,
    { timeout, polling: 200 },
  );
  await page.waitForTimeout(100);
}

test.beforeAll(async () => {
  await fetch(`${getBase()}/api/test/purge-all`, { method: 'POST' });
});

// ============================================================
// DS-1: Small scroll up near bottom disengages auto-follow
// ============================================================

test('DS-1. Small scroll up near bottom disengages auto-follow', async ({ page }) => {
  // Failure mode: user scrolls up just a little (20-40px from bottom).
  // With a nearBottom threshold of 50px, the next data chunk considers
  // the user "near bottom" and auto-scrolls them back.
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  // Scroll up by 20px from bottom — between old threshold (50px) and new (5px).
  // Old code: 20 < 50 → nearBottom → auto-scroll → user snapped to bottom.
  // Fixed code: 20 > 5 → NOT nearBottom → position preserved.
  const scrollSetup = await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    const target = Math.max(0, el.scrollHeight - el.clientHeight - 20);
    el.scrollTop = target;
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  }, id);
  await page.waitForTimeout(200);

  // Append several lines — should NOT auto-scroll since user scrolled away
  await appendDispatchOutput(id, makeOutputLines(10, 'Stream'));

  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.textContent.includes('Stream line 9');
    },
    id,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(200);

  // After appending 10 lines (~190px of new content), the distance from bottom
  // should be approximately 20 + 190 = 210px. With old code this would be 0 (at bottom).
  const metricsAfter = await getDispatchLogScrollMetrics(page, id);
  expect(metricsAfter.atBottom).toBe(false);
  // scrollTop should be near the original target, not at the new bottom
  expect(metricsAfter.scrollTop).toBeLessThan(scrollSetup.scrollTop + 10);
});

// ============================================================
// DS-2: Scroll position preserved while new data streams in
// ============================================================

test('DS-2. Scroll position preserved while new data streams in', async ({ page }) => {
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  // Scroll to top
  await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (el) el.scrollTop = 0;
  }, id);
  await page.waitForTimeout(300);

  const metricsScrolledUp = await getDispatchLogScrollMetrics(page, id);
  expect(metricsScrolledUp.atBottom).toBe(false);
  expect(metricsScrolledUp.scrollTop).toBeLessThan(10);

  // Append 20 more lines while user is scrolled up
  await appendDispatchOutput(id, makeOutputLines(20, 'New'));

  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.textContent.includes('New line 19');
    },
    id,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);

  // User must still be scrolled up
  const metricsAfter = await getDispatchLogScrollMetrics(page, id);
  expect(metricsAfter.atBottom).toBe(false);
  expect(metricsAfter.scrollTop).toBeLessThan(30);
});

// ============================================================
// DS-3: Auto-scroll resumes when user returns to bottom
// ============================================================

test('DS-3. Auto-scroll resumes when user returns to bottom', async ({ page }) => {
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  // Scroll up then back to bottom
  await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (el) el.scrollTop = 0;
  }, id);
  await page.waitForTimeout(300);

  await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (el) el.scrollTop = el.scrollHeight;
  }, id);
  await page.waitForTimeout(300);

  const metricsBottom = await getDispatchLogScrollMetrics(page, id);
  expect(metricsBottom.atBottom).toBe(true);

  // Append more lines — should auto-follow
  await appendDispatchOutput(id, makeOutputLines(20, 'Follow'));

  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.textContent.includes('Follow line 19');
    },
    id,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);

  const metricsAfter = await getDispatchLogScrollMetrics(page, id);
  expect(metricsAfter.atBottom).toBe(true);
});

// ============================================================
// DS-4: Scrollbar appears when dispatch content exceeds inline container height
// ============================================================

test('DS-4. Scrollbar appears when dispatch content exceeds inline container height', async ({ page }) => {
  // Failure mode: dispatch-log container grows unboundedly with content,
  // so overflow-y: auto never triggers a scrollbar. The user sees content
  // accumulating but cannot scroll.
  // At 12px font / 1.6 line-height (~19px/line), 200 lines ≈ 3800px,
  // far exceeding the 350px max-height constraint.
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(200, 'Planning'),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  const metrics = await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (!el) return null;
    const style = window.getComputedStyle(el);
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: style.overflowY,
    };
  }, id);

  // Content must overflow the container
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // Container must be constrained by max-height (350px + padding tolerance)
  expect(metrics.clientHeight).toBeLessThanOrEqual(400);
  // overflow-y must be auto (or scroll) so browser renders scrollbar
  expect(['auto', 'scroll']).toContain(metrics.overflowY);
});

// ============================================================
// DS-5: Scrollbar appears in focus popup with long content
// ============================================================

test('DS-5. Scrollbar appears in focus popup with long content', async ({ page }) => {
  // Failure mode: in the focus popup, .dispatch-log has max-height: none
  // and flex: 1. Without min-height: 0 on the flex chain, the container
  // grows to fit all content instead of being constrained by the 85vh popup.
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(200, 'FocusPlan'),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  // Open focus popup
  await page.click(`[data-focus-dispatch="${id}"]`);
  await expect(page.locator('.focus-overlay')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(300);

  const metrics = await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (!el) return null;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      windowHeight: window.innerHeight,
    };
  }, id);

  // Content must overflow
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // Container must be constrained by popup (85vh minus header/footer), not growing unboundedly
  expect(metrics.clientHeight).toBeLessThan(metrics.windowHeight * 0.85);

  // Verify user can scroll up and the position sticks
  await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (el) el.scrollTop = 0;
  }, id);
  await page.waitForTimeout(200);

  const scrollTop = await page.evaluate((id) => {
    return document.getElementById(`log-${id}`)?.scrollTop ?? -1;
  }, id);
  expect(scrollTop).toBe(0);
});

// ============================================================
// DS-6: Continuous rapid streaming preserves scroll position
// ============================================================

test('DS-6. Continuous rapid streaming preserves scroll position', async ({ page }) => {
  // Failure mode: rapid content_block_delta events override the user's
  // scroll position because savedScrollTop is read between browser
  // scroll event processing and the next WS message.
  test.setTimeout(60_000);

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(SEED_LINES),
  });

  await page.goto('/');
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });
  await waitForDispatchLogReady(page, id);

  // Scroll to top
  await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (el) el.scrollTop = 0;
  }, id);
  await page.waitForTimeout(200);

  // Rapidly append 50 lines — simulates fast Claude plan streaming
  await appendDispatchOutput(id, makeOutputLines(50, 'Rapid'));

  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.textContent.includes('Rapid line 49');
    },
    id,
    { timeout: 10_000 },
  );
  await page.waitForTimeout(300);

  // User must still be at the top
  const metricsAfter = await getDispatchLogScrollMetrics(page, id);
  expect(metricsAfter.atBottom).toBe(false);
  expect(metricsAfter.scrollTop).toBeLessThan(30);
});

// ============================================================
// DS-7: Scrollbar appears in work-item session slot (200px container)
// ============================================================

test('DS-7. Scrollbar appears in work-item session slot', async ({ page }) => {
  // Failure mode: dispatch-log inside .wi-sessions-container has
  // max-height: 200px but scrollbar doesn't appear due to parent
  // overflow: hidden on .dispatch-panel interfering.
  test.setTimeout(60_000);

  // Create a work item first, then link a dispatch to it
  const wi = await seedWorkItem({
    title: 'Scroll test item',
    status: 'draft',
    project_key: 'ticari/architect/main',
  });
  const workItemId = wi.id;

  const { dispatch_id: id } = await seedDispatch({
    status: 'running',
    output: makeOutputLines(100, 'WiPlan'),
    work_item_id: workItemId,
    project_key: 'ticari/architect/main',
  });

  // Navigate to the component view where work items are listed
  await page.goto('/#ticari/architect/main');
  await page.waitForTimeout(500);

  // The dispatch panel should appear somewhere on the page
  const logLocator = page.locator(`#log-${id}`);
  await expect(logLocator).toBeVisible({ timeout: 15_000 });

  // Wait for content to load
  await page.waitForFunction(
    (id) => {
      const el = document.getElementById(`log-${id}`);
      return el && el.dataset.replayDone === '1' && el.scrollHeight > 0;
    },
    id,
    { timeout: 20_000, polling: 200 },
  );
  await page.waitForTimeout(200);

  const metrics = await page.evaluate((id) => {
    const el = document.getElementById(`log-${id}`);
    if (!el) return null;
    const inWiSlot = !!el.closest('.wi-sessions-container');
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      inWiSlot,
    };
  }, id);

  // If placed inside wi-sessions-container, the 200px constraint applies;
  // otherwise the default 350px applies. Either way, it must be constrained.
  const maxExpected = metrics.inWiSlot ? 220 : 400;
  expect(metrics.clientHeight).toBeLessThanOrEqual(maxExpected);
  // Content must overflow, proving scrollbar is present
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
});
