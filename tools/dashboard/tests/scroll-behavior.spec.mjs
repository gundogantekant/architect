/**
 * Scroll Behavior E2E Test Suite
 *
 * 12 tests covering scroll integrity at scale (1 000-line seed), multi-pump
 * content growth, cross-browser scroll independence, and the dispatch-form →
 * session pipeline. All seeded terminals use generateSeedContent(1000) via the
 * server's withFakeContent flag.
 *
 * Tests run against an isolated test server started automatically by globalSetup.
 * Prerequisite: dashboard server must be running (dashctl.sh start).
 */

import { test, expect } from './fixtures.mjs';
import {
  purgeAll,
  seedTerminal,
  pumpTerminal,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermBufferLines,
  getXtermScrollMetrics,
  getEventStream,
} from './helpers.mjs';

import { SPEC_FILES } from './global-setup.mjs';
const BASE = `http://127.0.0.1:${3778 + (parseInt(process.env.TEST_WORKER_INDEX ?? '0') % SPEC_FILES.length)}`;

// generateSeedContent(1000): 7-line cycle, 143 empty lines at i%7===3 → 857 non-empty.
const SEED_LINES = 1000;
const SEED_MIN = 850; // safe threshold below 857 non-empty lines

test.beforeEach(purgeAll);

// ============================================================
// Suite A: Large Content (1 000 lines)
// ============================================================

test.describe('Suite A: Large Content', () => {
  test('S-1. 1 000-line terminal loads fully', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);

    // Must render at least SEED_MIN non-empty lines
    await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

    const metrics = await getXtermScrollMetrics(page, t.id);
    expect(metrics).not.toBeNull();
    // baseY > 0 confirms content has scrolled past the initial viewport
    expect(metrics.baseY).toBeGreaterThan(0);
  });

  test('S-2. 1 000-line scrollback has no blank-run artifacts', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

    const metrics = await getXtermScrollMetrics(page, t.id);
    // Read a large slice from the top of the scrollback
    const lines = await getXtermBufferLines(page, t.id, 0, Math.min(300, metrics.baseY + metrics.rows));

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

    // Seed has one blank per 7-line cycle; never more than 2 consecutive blanks
    expect(maxConsecutiveBlanks).toBeLessThanOrEqual(2);
  });

  test('S-3. ANSI codes processed — no raw escape sequences in buffer', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

    // Read the first 100 non-empty buffer lines from the scrollback
    const lines = await getXtermBufferLines(page, t.id, 0, 120);
    const nonEmpty = lines.filter((l) => l.trim().length > 0).slice(0, 100);

    expect(nonEmpty.length).toBeGreaterThanOrEqual(50);

    for (const line of nonEmpty) {
      // translateToString(true) returns cell characters; if ANSI was processed
      // correctly, raw escape byte \x1b must NOT appear as a visible character
      expect(line).not.toContain('\x1b');
    }
  });

  test('S-4. Line content preserved across scroll round-trip', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

    // Capture first 10 lines from the top of the scrollback
    const linesBefore = await getXtermBufferLines(page, t.id, 0, 10);

    // Scroll to bottom, then back to top
    await page.evaluate((id) => {
      const term = window._termSessions?.get(id)?._term;
      if (term) term.scrollToBottom();
    }, t.id);

    await page.evaluate((id) => {
      const term = window._termSessions?.get(id)?._term;
      if (term) term.scrollToTop();
    }, t.id);

    const linesAfter = await getXtermBufferLines(page, t.id, 0, 10);

    expect(linesAfter).toEqual(linesBefore);
  });
});

// ============================================================
// Suite B: Multi-Pump Content Growth
// ============================================================

test.describe('Suite B: Multi-Pump Content Growth', () => {
  test('S-5. Three sequential 300-line pumps grow content monotonically', async ({ page }) => {
    test.setTimeout(180_000);

    // Terminal must be running to accept pump events
    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    // Wait for EventQueue to fully drain — more reliable than counting non-empty lines
    // because it avoids iterating the full buffer at polling frequency (RAF starvation).
    await page.waitForFunction((id) => {
      const eq = window._termSessions?.get(id)?._eventQueue;
      return eq && eq._ready && !eq._draining && eq._queue.length === 0;
    }, t.id, { timeout: 60_000, polling: 500 });

    const metricsBase = await getXtermScrollMetrics(page, t.id);

    // pumpAndWait: fire a pump then wait until ALL pump events are processed by xterm.
    // Uses server headSeq + client lastSeq to avoid starting the next pump while the
    // previous pump's events are still draining through the EventQueue.
    const pumpAndWait = async () => {
      const { head_seq: seqBefore } = await getEventStream(t.id);
      await pumpTerminal(t.id, { linesPerSecond: 30, duration: 10 });
      const targetSeq = seqBefore + 300; // 30 lines/sec × 10 s
      await page.waitForFunction(
        ({ id, seq }) => (window._termSessions?.get(id)?._wsManager?.lastSeq ?? 0) >= seq,
        { id: t.id, seq: targetSeq },
        { timeout: 60_000, polling: 500 },
      );
    };

    // Pump 1: 300 lines
    await pumpAndWait();
    const metricsAfterPump1 = await getXtermScrollMetrics(page, t.id);
    expect(metricsAfterPump1.baseY).toBeGreaterThan(metricsBase.baseY);

    // Pump 2: another 300 lines
    await pumpAndWait();
    const metricsAfterPump2 = await getXtermScrollMetrics(page, t.id);
    expect(metricsAfterPump2.baseY).toBeGreaterThan(metricsAfterPump1.baseY);

    // Pump 3: another 300 lines
    await pumpAndWait();
    const metricsAfterPump3 = await getXtermScrollMetrics(page, t.id);
    expect(metricsAfterPump3.baseY).toBeGreaterThan(metricsAfterPump2.baseY);
  });

  test('S-6. Content at top unchanged after three pump rounds', async ({ page }) => {
    test.setTimeout(180_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    // Wait for EventQueue to fully drain before capturing baseline
    await page.waitForFunction((id) => {
      const eq = window._termSessions?.get(id)?._eventQueue;
      return eq && eq._ready && !eq._draining && eq._queue.length === 0;
    }, t.id, { timeout: 60_000, polling: 500 });

    // Capture the top 5 lines as the immutable baseline
    const topLinesBefore = await getXtermBufferLines(page, t.id, 0, 5);
    expect(topLinesBefore.filter((l) => l.trim()).length).toBeGreaterThanOrEqual(3);

    // pumpAndWait: fire a pump then wait until ALL pump events are processed by xterm.
    // Uses server headSeq + client lastSeq to avoid starting the next pump while the
    // previous pump's events are still draining through the EventQueue.
    const pumpAndWait = async () => {
      const { head_seq: seqBefore } = await getEventStream(t.id);
      await pumpTerminal(t.id, { linesPerSecond: 30, duration: 10 });
      const targetSeq = seqBefore + 300; // 30 lines/sec × 10 s
      await page.waitForFunction(
        ({ id, seq }) => (window._termSessions?.get(id)?._wsManager?.lastSeq ?? 0) >= seq,
        { id: t.id, seq: targetSeq },
        { timeout: 60_000, polling: 500 },
      );
    };

    await pumpAndWait();
    await pumpAndWait();
    await pumpAndWait();

    // Top lines must be identical — appends must not corrupt historical content
    const topLinesAfter = await getXtermBufferLines(page, t.id, 0, 5);
    expect(topLinesAfter).toEqual(topLinesBefore);
  });

  test('S-7. Scroll position at top preserved while live pump is active', async ({ page }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, SEED_MIN, 60_000);

    // Scroll to top
    await page.evaluate((id) => {
      const term = window._termSessions?.get(id)?._term;
      if (term) term.scrollToTop();
    }, t.id);

    const metricsAtTop = await getXtermScrollMetrics(page, t.id);
    expect(metricsAtTop.atBottom).toBe(false);

    // Read top 10 lines now (seed content)
    const topLinesBefore = await getXtermBufferLines(page, t.id, 0, 10);
    const seedLinesCount = topLinesBefore.filter((l) => l.trim().match(/commit|Author:|feat:/)).length;
    expect(seedLinesCount).toBeGreaterThan(0);

    // Start pump at 5 lines/sec for 3 seconds (15 lines, fire-and-forget)
    await pumpTerminal(t.id, { linesPerSecond: 5, duration: 3 });

    // Wait 4 seconds (longer than pump duration to let it fully run)
    await page.waitForTimeout(4000);

    // Top 10 buffer lines should still contain seed content, not pump lines
    const topLinesAfter = await getXtermBufferLines(page, t.id, 0, 10);
    const pumpLinesAtTop = topLinesAfter.filter((l) => l.trim().startsWith('pump-line-'));
    expect(pumpLinesAtTop.length).toBe(0);

    // User position at top must not have been auto-scrolled to bottom
    const metricsAfterPump = await getXtermScrollMetrics(page, t.id);
    expect(metricsAfterPump.atBottom).toBe(false);
  });
});

// ============================================================
// Suite C: Multi-Browser Scroll Independence
// ============================================================

test.describe('Suite C: Multi-Browser Scroll Independence', () => {
  test('S-8. Two browsers have independent scroll states during live pump', async ({ browser }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES, status: 'running' });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      // Both browsers load the terminal
      await Promise.all([
        page1.goto(`${BASE}/#terminals`),
        page2.goto(`${BASE}/#terminals`),
      ]);
      await Promise.all([
        waitForTerminalLive(page1, t.id),
        waitForTerminalLive(page2, t.id),
      ]);
      await Promise.all([
        waitForTerminalContent(page1, t.id, SEED_MIN, 60_000),
        waitForTerminalContent(page2, t.id, SEED_MIN, 60_000),
      ]);

      // Browser1: scroll to top
      await page1.evaluate((id) => {
        const term = window._termSessions?.get(id)?._term;
        if (term) term.scrollToTop();
      }, t.id);

      // Browser2: stays at bottom (default)
      const metrics2Before = await getXtermScrollMetrics(page2, t.id);
      expect(metrics2Before.atBottom).toBe(true);
      const metrics1Before = await getXtermScrollMetrics(page1, t.id);
      expect(metrics1Before.atBottom).toBe(false);

      // Pump 10 more lines
      await pumpTerminal(t.id, { linesPerSecond: 10, duration: 1 });
      await page1.waitForTimeout(2500);
      await page2.waitForTimeout(2500);

      // Browser1 (at top) must NOT have been auto-scrolled
      const metrics1After = await getXtermScrollMetrics(page1, t.id);
      expect(metrics1After.atBottom).toBe(false);

      // Browser2 (at bottom) must have followed new content
      const metrics2After = await getXtermScrollMetrics(page2, t.id);
      expect(metrics2After.atBottom).toBe(true);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('S-9. Late-joining browser does not reset existing browser scroll position', async ({ browser }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      await page1.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page1, t.id);
      await waitForTerminalContent(page1, t.id, SEED_MIN, 60_000);

      // Browser1: scroll to approximately 25% of scrollback
      await page1.evaluate((id) => {
        const term = window._termSessions?.get(id)?._term;
        if (!term) return;
        const buf = term.buffer.active;
        const targetY = Math.round(buf.baseY * 0.25);
        term.scrollLines(targetY - buf.viewportY);
      }, t.id);

      const metrics1Before = await getXtermScrollMetrics(page1, t.id);
      const viewportYBefore = metrics1Before.viewportY;
      expect(metrics1Before.atBottom).toBe(false);

      // Browser2 joins now
      await page2.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page2, t.id);
      await waitForTerminalContent(page2, t.id, SEED_MIN, 60_000);

      // Short wait to ensure any side-effects from page2 joining have settled
      await page1.waitForTimeout(500);

      // Browser1's scroll position must be unchanged
      const metrics1After = await getXtermScrollMetrics(page1, t.id);
      expect(metrics1After.viewportY).toBe(viewportYBefore);
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });

  test('S-10. Late-joining browser sees full historical content', async ({ browser }) => {
    test.setTimeout(90_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    try {
      await page1.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page1, t.id);
      await waitForTerminalContent(page1, t.id, SEED_MIN, 60_000);

      const metrics1 = await getXtermScrollMetrics(page1, t.id);

      // Browser2 connects after browser1 has fully loaded
      await page2.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page2, t.id);
      await waitForTerminalContent(page2, t.id, SEED_MIN, 60_000);

      const metrics2 = await getXtermScrollMetrics(page2, t.id);

      // Late-joining browser must show the same total buffer depth as the first.
      // Compare totalLines (baseY + rows) to account for different row counts across contexts.
      expect(metrics2.baseY + metrics2.rows).toBeGreaterThanOrEqual(
        metrics1.baseY + metrics1.rows - 5,
      );
    } finally {
      await ctx1.close();
      await ctx2.close();
    }
  });
});

// ============================================================
// Suite D: Session Pipeline
// ============================================================

test.describe('Suite D: Session Pipeline', () => {
  test('S-11. Terminal panel shows agent and permission-mode badges', async ({ page }) => {
    test.setTimeout(60_000);

    // seed-terminal creates with agent_type:'claude', permission_mode:'plan'
    const t = await seedTerminal({ withFakeContent: true, lines: 50 });

    await page.goto(`${BASE}/#terminals`);
    await waitForTerminalLive(page, t.id);

    const panel = page.locator(`#terminal-${t.id}`);

    // Agent badge: [Claude]
    const agentBadge = panel.locator('.agent-badge[data-agent="claude"]');
    await expect(agentBadge).toBeVisible({ timeout: 10_000 });
    await expect(agentBadge).toContainText('Claude');

    // Plan badge: [plan]
    const planBadge = panel.locator('.plan-badge');
    await expect(planBadge).toBeVisible({ timeout: 10_000 });
    await expect(planBadge).toContainText('plan');
  });

  test('S-12. Full history reload: all 1 000 lines visible after browser close and reopen', async ({ browser }) => {
    test.setTimeout(120_000);

    const t = await seedTerminal({ withFakeContent: true, lines: SEED_LINES });

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();

    let baseY1;
    try {
      await page1.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page1, t.id);
      await waitForTerminalContent(page1, t.id, SEED_MIN, 60_000);

      const metrics1 = await getXtermScrollMetrics(page1, t.id);
      baseY1 = metrics1.baseY;
      expect(baseY1).toBeGreaterThan(0);
    } finally {
      await ctx1.close();
    }

    // Browser2 opens a fresh context (simulates reopening the dashboard)
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    try {
      await page2.goto(`${BASE}/#terminals`);
      await waitForTerminalLive(page2, t.id);
      await waitForTerminalContent(page2, t.id, SEED_MIN, 60_000);

      const metrics2 = await getXtermScrollMetrics(page2, t.id);

      // Fresh browser must show the full seed scrollback.
      // Compare total buffer lines (baseY + rows) against SEED_LINES — this is
      // robust to different row counts between browser contexts (FitAddon may vary).
      expect(metrics2.baseY + metrics2.rows).toBeGreaterThanOrEqual(SEED_LINES - 5);
    } finally {
      await ctx2.close();
    }
  });
});
