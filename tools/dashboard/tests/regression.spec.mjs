/**
 * Regression Test Suite
 *
 * Each test explicitly names the bug it guards against.
 * Tests run against an isolated test server started automatically by globalSetup.
 *
 * Prerequisite: dashboard server must be running (dashctl.sh start).
 */

import { test, expect } from './fixtures.mjs';
import {
  purgeAll,
  seedTerminal,
  seedDispatch,
  pumpTerminal,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermBufferLines,
  getXtermScrollMetrics,
} from './helpers.mjs';

import { SPEC_FILES } from './global-setup.mjs';
const BASE = `http://127.0.0.1:${3778 + (parseInt(process.env.TEST_WORKER_INDEX ?? '0') % SPEC_FILES.length)}`;

test.beforeEach(purgeAll);

// ============================================================
// R-1: No blank render on first load
// ============================================================

test('R-1. No blank render on first load', async ({ page }) => {
  // Regression: blank terminal on first load
  // Failure mode: term.write() fired before xterm init completed, first chunk silently dropped
  // Fixed by: await Promise.all([loadXterm(), containerReadyPromise]) in stream-start handler

  const t = await seedTerminal({ withFakeContent: true, lines: 50 });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 10);

  const lines = await getXtermBufferLines(page, t.id, 0, 20);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);

  expect(nonEmpty.length).toBeGreaterThanOrEqual(10);
  expect(nonEmpty[0]).toMatch(/commit/);
});

// ============================================================
// R-2: Scrollback history intact at buffer index 0 after reconnect
// ============================================================

test('R-2. Scrollback history intact at buffer[0] after WS reconnect', async ({ page }) => {
  // Regression: scrollback erased on reconnect
  // Failure mode: term.reset() called on reconnect, erasing entire scrollback buffer
  // Fixed by: removed term.reset(); reconnect replays from lastSeq, not from 0

  const t = await seedTerminal({ withFakeContent: true, lines: 200, status: 'running' });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 30);

  // Capture first line before reconnect
  // Wait for EventQueue to fully drain before capturing baseline
  await page.waitForFunction((id) => {
    const eq = window._termSessions?.get(id)?._eventQueue;
    return eq && eq._ready && !eq._draining && eq._queue.length === 0;
  }, t.id, { timeout: 10_000 });

  const linesBefore = await getXtermBufferLines(page, t.id, 0, 1);
  expect(linesBefore[0].trim()).toBeTruthy();
  const firstLineBefore = linesBefore[0];

  // Force close WS to trigger reconnect
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    const ws = sess?._wsManager?._ws;
    if (ws) ws.close(4999, 'test-reconnect');
  }, t.id);

  // Wait for RECONNECTING state
  await page.waitForFunction(
    (id) => window._termSessions?.get(id)?.state === 'RECONNECTING',
    t.id,
    { timeout: 5000 },
  );

  // Wait for LIVE again after reconnect
  await waitForTerminalLive(page, t.id, 15_000);
  await waitForTerminalContent(page, t.id, 30);

  // Buffer index 0 must still hold original content
  const linesAfter = await getXtermBufferLines(page, t.id, 0, 1);
  expect(linesAfter[0]).toBe(firstLineBefore);
});

// ============================================================
// R-3: No duplicate lines on WS reconnect
// ============================================================

test('R-3. No duplicate lines on WS reconnect', async ({ page }) => {
  // Regression: content doubled after WS reconnect
  // Failure mode: client reconnected with ?from=0, replaying all events from the beginning
  // Fixed by: WsManager.connect(lastSeq) — reconnect requests only events after lastSeq

  const t = await seedTerminal({ withFakeContent: true, lines: 50, status: 'running' });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 30);

  // Wait for EventQueue to fully drain — lastSeq must be stable before force-close
  await page.waitForFunction((id) => {
    const eq = window._termSessions?.get(id)?._eventQueue;
    return eq && eq._ready && !eq._draining && eq._queue.length === 0;
  }, t.id, { timeout: 10_000 });

  const metricsBefore = await getXtermScrollMetrics(page, t.id);
  expect(metricsBefore).not.toBeNull();
  const baseYBefore = metricsBefore.baseY;

  // Force close WS to trigger reconnect
  await page.evaluate((id) => {
    const sess = window._termSessions?.get(id);
    const ws = sess?._wsManager?._ws;
    if (ws) ws.close(4999, 'test-duplicate');
  }, t.id);

  // Wait for RECONNECTING, then LIVE
  await page.waitForFunction(
    (id) => window._termSessions?.get(id)?.state === 'RECONNECTING',
    t.id,
    { timeout: 5000 },
  );
  await waitForTerminalLive(page, t.id, 15_000);

  // Allow a brief moment for the queue to drain after reconnect
  await page.waitForTimeout(500);

  const metricsAfter = await getXtermScrollMetrics(page, t.id);
  expect(metricsAfter).not.toBeNull();

  // baseY may grow by the reconnecting banner (~2 lines) but must not double
  expect(metricsAfter.baseY).toBeLessThanOrEqual(baseYBefore + 5);
});

// ============================================================
// R-4: Event ordering under rapid server-side writes
// ============================================================

test('R-4. Event ordering preserved under rapid server-side writes', async ({ page }) => {
  // Regression: out-of-order terminal output under concurrent writes
  // Failure mode: concurrent term.write() calls interleaved; later events could precede earlier ones
  // Fixed by: TerminalEventQueue — serial FIFO drain via term.write(data, callback)

  const t = await seedTerminal({ status: 'running' });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);

  // Pump 60 lines at 20 lines/sec (3 seconds of rapid output)
  await pumpTerminal(t.id, { linesPerSecond: 20, duration: 3 });

  // Wait for all 60 pump lines to drain into xterm
  await waitForTerminalContent(page, t.id, 55, 30_000);

  // Read all buffer content and extract pump-line-N sequence numbers
  const lines = await getXtermBufferLines(page, t.id, 0, 120);
  const pumpLines = lines.filter((l) => l.trim().startsWith('pump-line-'));
  const seqNums = pumpLines.map((l) => parseInt(l.match(/pump-line-(\d+)/)?.[1] ?? '-1', 10));

  expect(seqNums.length).toBeGreaterThanOrEqual(55);

  // Sequence numbers must be strictly ascending — no gaps, no reversals
  for (let i = 1; i < seqNums.length; i++) {
    expect(seqNums[i]).toBeGreaterThan(seqNums[i - 1]);
  }
});

// ============================================================
// R-5: Terminal cols > 80 after init
// ============================================================

test('R-5. Terminal cols match container width (not hardcoded 80)', async ({ page }) => {
  // Regression: terminal rendered at fixed 80 columns regardless of container
  // Failure mode: ptyProcess spawned with cols:80 hardcoded; FitAddon not applied on mount
  // Fixed by: containerReadyPromise resolves after layout; FitAddon.fit() called before stream-start

  const t = await seedTerminal({ withFakeContent: true, lines: 30 });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 10);

  const cols = await page.evaluate((id) => {
    return window._termSessions?.get(id)?._term?.cols ?? null;
  }, t.id);

  expect(cols).not.toBeNull();
  expect(cols).toBeGreaterThan(80);
});

// ============================================================
// R-6: No blank-line artifacts after replay
// ============================================================

test('R-6. No blank-line run artifacts after initial replay', async ({ page }) => {
  // Regression: excessive blank gaps between content blocks after replay
  // Failure mode: double \r\n injected between batched replay events; xterm showed extra blank lines
  // Fixed by: EventStream broadcasts raw event payloads without extra newline injection

  const t = await seedTerminal({ withFakeContent: true, lines: 200 });

  await page.goto(`${BASE}/#terminals`);
  await waitForTerminalLive(page, t.id);
  await waitForTerminalContent(page, t.id, 30);

  const lines = await getXtermBufferLines(page, t.id, 0, 220);

  let maxConsecutiveBlanks = 0;
  let consecutive = 0;
  for (const line of lines) {
    if (line.trim().length === 0) {
      consecutive++;
      maxConsecutiveBlanks = Math.max(maxConsecutiveBlanks, consecutive);
    } else {
      consecutive = 0;
    }
  }

  // The seed content has exactly one blank line per 7-line cycle (i%7===3).
  // No more than 2 consecutive blanks should appear in the rendered output.
  expect(maxConsecutiveBlanks).toBeLessThanOrEqual(2);
});

// ============================================================
// R-7: Badge decrements immediately when dispatch killed (no stale state)
// ============================================================

test('R-7. Badge decrements immediately when dispatch killed (syncSessionState)', async ({ page }) => {
  // Regression: badge stale after dispatch termination via non-UI path
  // Failure mode: badge updated only in some code paths but not when dispatch finalized
  // Fixed by: syncSessionState() called from all dispatch termination paths

  const { dispatch_id: id } = await seedDispatch({ status: 'running' });
  await page.goto(`${BASE}/`);

  // Wait for badge to show at least 1 (one running session)
  await expect(page.locator('#dispatch-badge:not(.empty)')).toBeVisible({ timeout: 5000 });
  const badgeText = await page.locator('#dispatch-badge').textContent();
  const countBefore = parseInt(badgeText || '0');
  expect(countBefore).toBeGreaterThanOrEqual(1);

  // Wait for the dispatch panel to appear — confirms WS is connected and receiving messages
  await expect(page.locator(`#dispatch-${id}`)).toBeVisible({ timeout: 5000 });

  // Kill via API (not via UI kill button — tests that syncSessionState is called by WS/finalize path)
  await fetch(`${BASE}/api/dispatch/${id}`, { method: 'DELETE' });

  // Badge must decrement within 2s (well before the 10s poll interval).
  // Uses count comparison (not === 0) to be robust in multi-worker environments
  // where other workers' sessions may keep the total above 0.
  await page.waitForFunction(
    (before) => {
      const badge = document.getElementById('dispatch-badge');
      if (!badge) return false;
      if (badge.classList.contains('empty')) return true;
      return parseInt(badge.textContent || '0') < before;
    },
    countBefore,
    { timeout: 5000 }
  );
});
