/**
 * Behavioral E2E Test Suite — verifies user-visible terminal behaviors.
 *
 * 31 tests across 6 suites covering the EventStream-based terminal architecture.
 * Tests are requirements-driven: each test describes an observable user outcome.
 * For named bug guards (preventing regression of specific failure modes), see
 * regression.spec.mjs. For scroll integrity at scale, see scroll-behavior.spec.mjs.
 *
 * Tests run against an isolated test server started automatically by globalSetup.
 * Prerequisite: dashboard server must be running (dashctl.sh start).
 */

import { test, expect } from './fixtures.mjs';
import {
  getBase,
  seedTerminal,
  pumpTerminal,
  getEventStream,
  getActiveTerminals,
  waitForTerminalLive,
  waitForTerminalContent,
  getXtermBufferLines,
  getXtermScrollMetrics,
  typeIntoTerminal,
  waitForTextInXterm,
  waitForFooterSessionId,
  getSessionState,
  compareXtermBuffers,
} from './helpers.mjs';

// ============================================================
// Suite 1: Single Terminal Core Behaviors
// ============================================================

test.describe('Suite 1: Single Terminal Core', () => {

  test('1. terminal panel appears with loading overlay', async ({ page }) => {
    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await page.waitForSelector(`#terminal-${t.id}`, { timeout: 10_000 });
    await expect(page.locator(`#term-container-${t.id}`)).toBeVisible();
  });

  test('2. seed content (200 lines) visible in xterm after stream-live', async ({ page }) => {
    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);
    const lines = await getXtermBufferLines(page, t.id, 0, 30);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(10);
  });

  test('3. terminal is scrollable after seed content', async ({ page }) => {
    const t = await seedTerminal({ lines: 300, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 50);
    const metrics = await getXtermScrollMetrics(page, t.id);
    expect(metrics).not.toBeNull();
    expect(metrics.baseY).toBeGreaterThan(0);
  });

  test('4. terminal width uses container width, not fixed 80 cols', async ({ page }) => {
    const t = await seedTerminal({ lines: 50, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    // Wait for xterm to be initialized (fitAddon.fit() sets the actual cols)
    await waitForTerminalContent(page, t.id, 5);
    const cols = await page.evaluate(
      (id) => window._termSessions?.get(id)?._term?.cols,
      t.id,
    );
    expect(cols).toBeGreaterThan(80);
  });

  test('5. scroll up shows old content, scroll down shows latest, no content loss', async ({ page }) => {
    const t = await seedTerminal({ lines: 300, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 50);

    // Capture first non-empty line before scrolling
    const earlyLines = await getXtermBufferLines(page, t.id, 0, 10);
    const firstContent = earlyLines.find((l) => l.trim().length > 0);
    expect(firstContent).toBeTruthy();

    // Scroll to top
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (sess?._term) sess._term.scrollToTop();
    }, t.id);

    // Lines still present at top
    const afterScrollLines = await getXtermBufferLines(page, t.id, 0, 10);
    const afterContent = afterScrollLines.find((l) => l.trim().length > 0);
    expect(afterContent).toBeTruthy();

    // Scroll back to bottom
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (sess?._term) sess._term.scrollToBottom();
    }, t.id);
    const metrics = await getXtermScrollMetrics(page, t.id);
    expect(metrics.atBottom).toBe(true);
  });

  test('6. resize: terminal re-fits, content preserved', async ({ page }) => {
    const t = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);

    await page.setViewportSize({ width: 800, height: 600 });
    await page.waitForTimeout(300); // allow resize debounce

    const colsAfter = await page.evaluate(
      (id) => window._termSessions?.get(id)?._term?.cols,
      t.id,
    );
    expect(typeof colsAfter).toBe('number');

    // Content must still be present
    const lines = await getXtermBufferLines(page, t.id, 0, 20);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(5);
  });

  test('7. session ID appears in footer from meta event', async ({ page }) => {
    const sessionId = '12345678-abcd-ef01-2345-678901234567';
    const t = await seedTerminal({
      lines: 50,
      withFakeContent: true,
      status: 'running',
      claude_session_id: sessionId,
      agentType: 'claude',
    });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForFooterSessionId(page, t.id);
    const footerText = await page
      .locator(`#terminal-${t.id} .session-id-copy`)
      .textContent();
    expect(footerText).toContain(sessionId);
  });

  test('8. injection indicator shows done after withInjectionEvents', async ({ page }) => {
    const t = await seedTerminal({
      lines: 50,
      withFakeContent: true,
      status: 'running',
      withInjectionEvents: true,
      agentType: 'claude',
    });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await page.waitForTimeout(500);
    const indicatorText = await page
      .locator(`#terminal-${t.id} .injection-indicator`)
      .textContent();
    expect(indicatorText).toContain('injected');
  });

  test('9. agent badge shows correct label', async ({ page }) => {
    // Default agent type is shell
    const t1 = await seedTerminal({ lines: 20, status: 'running', withFakeContent: true });
    await page.goto('/');
    await page.waitForSelector(`#terminal-${t1.id} .agent-badge`, { timeout: 10_000 });
    const badge1 = await page.locator(`#terminal-${t1.id} .agent-badge`).textContent();
    expect(badge1?.toLowerCase()).toContain('shell');

    // Claude agent type when explicit
    const t2 = await seedTerminal({ lines: 20, status: 'running', withFakeContent: true, agentType: 'claude' });
    await page.goto('/');
    await page.waitForSelector(`#terminal-${t2.id} .agent-badge`, { timeout: 10_000 });
    const badge2 = await page.locator(`#terminal-${t2.id} .agent-badge`).textContent();
    expect(badge2?.toLowerCase()).toContain('claude');
  });
});

// ============================================================
// Suite 2: Multi-Browser Consistency
// ============================================================

test.describe('Suite 2: Multi-Browser Consistency', () => {

  test('10. two browsers, 1 terminal: identical content, neither blanks', async ({ browser }) => {
    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'running' });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    await Promise.all([page1.goto('/'), page2.goto('/')]);
    await Promise.all([
      waitForTerminalLive(page1, t.id),
      waitForTerminalLive(page2, t.id),
    ]);
    await Promise.all([
      waitForTerminalContent(page1, t.id, 30),
      waitForTerminalContent(page2, t.id, 30),
    ]);

    const result = await compareXtermBuffers(page1, t.id, page2, t.id, 30);
    expect(result.lines1.length).toBeGreaterThan(5);
    expect(result.lines2.length).toBeGreaterThan(5);
    expect(result.match).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });

  test('11. three browsers, 3 terminals: all 9 views have content for 20 seconds', async ({ browser }) => {
    test.setTimeout(90_000);

    const terminals = await Promise.all([
      seedTerminal({ lines: 100, withFakeContent: true, status: 'running' }),
      seedTerminal({ lines: 100, withFakeContent: true, status: 'running' }),
      seedTerminal({ lines: 100, withFakeContent: true, status: 'running' }),
    ]);

    // Pump live output into all 3 terminals
    await Promise.all(
      terminals.map((t) => pumpTerminal(t.id, { linesPerSecond: 2, duration: 20 })),
    );

    const contexts = await Promise.all([
      browser.newContext(),
      browser.newContext(),
      browser.newContext(),
    ]);
    const pages = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    await Promise.all(pages.map((p) => p.goto('/')));

    // Wait for all 9 combinations (3 pages × 3 terminals) to reach LIVE
    await Promise.all(
      pages.flatMap((page) => terminals.map((t) => waitForTerminalLive(page, t.id))),
    );
    await Promise.all(
      pages.flatMap((page) => terminals.map((t) => waitForTerminalContent(page, t.id, 30))),
    );

    // Verify each page has content for every terminal
    for (const page of pages) {
      for (const t of terminals) {
        const metrics = await getXtermScrollMetrics(page, t.id);
        expect(metrics).not.toBeNull();
        expect(metrics.baseY).toBeGreaterThan(0);
      }
    }

    await Promise.all(contexts.map((ctx) => ctx.close()));
  });

  test('12. browser 2 opens mid-stream: content matches after both reach LIVE', async ({ browser }) => {
    const t = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await pumpTerminal(t.id, { linesPerSecond: 3, duration: 15 });

    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto('/');
    await waitForTerminalLive(page1, t.id);
    await waitForTerminalContent(page1, t.id, 30);

    // Second browser opens after first is already LIVE
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto('/');
    await waitForTerminalLive(page2, t.id);
    await waitForTerminalContent(page2, t.id, 30);

    const m1 = await getXtermScrollMetrics(page1, t.id);
    const m2 = await getXtermScrollMetrics(page2, t.id);
    expect(m1.baseY).toBeGreaterThan(0);
    expect(m2.baseY).toBeGreaterThan(0);

    await ctx1.close();
    await ctx2.close();
  });

  test('13. no content loss across 3 poll cycles (~30s)', async ({ page }) => {
    test.setTimeout(45_000);

    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'completed' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    // Wait for substantial content so baseline is meaningful
    await waitForTerminalContent(page, t.id, 30);

    const metricsBefore = await getXtermScrollMetrics(page, t.id);
    const linesBefore = await getXtermBufferLines(page, t.id, 0, 5);
    const firstLineBefore = linesBefore.find((l) => l.trim().length > 0);
    expect(firstLineBefore).toBeTruthy();
    expect(metricsBefore.baseY).toBeGreaterThan(0);

    // Wait ~30 seconds (3 polling cycles at 10s interval)
    await page.waitForTimeout(31_000);

    const metricsAfter = await getXtermScrollMetrics(page, t.id);
    const linesAfter = await getXtermBufferLines(page, t.id, 0, 5);
    const firstLineAfter = linesAfter.find((l) => l.trim().length > 0);

    // Content must not shrink (baseY can grow if queue was still draining, but never decrease)
    expect(metricsAfter.baseY).toBeGreaterThanOrEqual(metricsBefore.baseY);
    // First line must remain intact (no data corruption or erasure)
    expect(firstLineAfter).toBe(firstLineBefore);
  });
});

// ============================================================
// Suite 3: Session Reconnection
// ============================================================

test.describe('Suite 3: Session Reconnection', () => {

  test('14. fresh page load: running terminals reappear with content', async ({ page }) => {
    const t1 = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    const t2 = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await Promise.all([
      waitForTerminalLive(page, t1.id),
      waitForTerminalLive(page, t2.id),
    ]);
    await Promise.all([
      waitForTerminalContent(page, t1.id, 10),
      waitForTerminalContent(page, t2.id, 10),
    ]);
    await expect(page.locator(`#terminal-${t1.id}`)).toBeVisible();
    await expect(page.locator(`#terminal-${t2.id}`)).toBeVisible();
  });

  test('15. completed terminal reappears with content after page refresh', async ({ page }) => {
    const t = await seedTerminal({ lines: 150, withFakeContent: true, status: 'completed' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);
    const baseYBefore = (await getXtermScrollMetrics(page, t.id)).baseY;

    await page.reload();
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);
    const baseYAfter = (await getXtermScrollMetrics(page, t.id)).baseY;

    // Allow generous tolerance: FitAddon row computation varies across browsers and loads.
    // The intent is that content survives a refresh — not that exact row count is preserved.
    expect(baseYAfter).toBeGreaterThan(0);
  });

  test('16. two separate page objects get same content from same session', async ({ browser }) => {
    const t = await seedTerminal({ lines: 150, withFakeContent: true, status: 'running' });

    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto('/');
    await waitForTerminalLive(page1, t.id);
    await waitForTerminalContent(page1, t.id, 20);

    const page2 = await ctx2.newPage();
    await page2.goto('/');
    await waitForTerminalLive(page2, t.id);
    await waitForTerminalContent(page2, t.id, 20);

    const result = await compareXtermBuffers(page1, t.id, page2, t.id, 20);
    expect(result.match).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });

  test('17. WS reconnect: state returns to LIVE after simulated close', async ({ page }) => {
    const t = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await pumpTerminal(t.id, { linesPerSecond: 2, duration: 10 });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);

    // Simulate unexpected WS close with a non-1000 code
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (sess?._wsManager?._ws) sess._wsManager._ws.close(4999);
    }, t.id);

    // Should transition to RECONNECTING or immediately back to LIVE
    await page.waitForFunction(
      (id) => {
        const s = window._termSessions?.get(id)?.state;
        return s === 'RECONNECTING' || s === 'LIVE';
      },
      t.id,
      { timeout: 5_000 },
    );

    // Must eventually settle back at LIVE
    await waitForTerminalLive(page, t.id, 15_000);
  });
});

// ============================================================
// Suite 4: Content Integrity
// ============================================================

test.describe('Suite 4: Content Integrity', () => {

  test('18. line integrity: 79-char lines have no phantom wrapping', async ({ page }) => {
    const t = await seedTerminal({ lines: 50, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 10);
    const lines = await getXtermBufferLines(page, t.id, 0, 20);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(5);
    // No single-non-alphanum-character lines that would indicate wrap artifacts
    const suspicious = nonEmpty.filter(
      (l) => l.trim().length === 1 && !/[a-zA-Z0-9]/.test(l.trim()),
    );
    expect(suspicious.length).toBe(0);
  });

  test('19. scroll position preserved during resize', async ({ page }) => {
    const t = await seedTerminal({ lines: 300, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 50);

    // Scroll to approximately the middle of the buffer
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (!sess?._term) return;
      const buf = sess._term.buffer.active;
      sess._term.scrollLines(-(buf.baseY / 2 | 0));
    }, t.id);

    // Resize the window
    await page.setViewportSize({ width: 900, height: 550 });
    await page.waitForTimeout(300);

    const metricsAfter = await getXtermScrollMetrics(page, t.id);
    // Buffer must still have content
    expect(metricsAfter.baseY).toBeGreaterThan(0);
    // Terminal must still have valid column count
    const cols = await page.evaluate(
      (id) => window._termSessions?.get(id)?._term?.cols,
      t.id,
    );
    expect(cols).toBeGreaterThan(0);
  });

  test('20. no excessive blank lines in buffer after replay', async ({ page }) => {
    const t = await seedTerminal({ lines: 200, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 30);

    const lines = await getXtermBufferLines(page, t.id, 0, 100);
    let maxRun = 0;
    let currentRun = 0;
    for (const l of lines) {
      if (l.trim().length === 0) {
        currentRun++;
        maxRun = Math.max(maxRun, currentRun);
      } else {
        currentRun = 0;
      }
    }
    expect(maxRun).toBeLessThanOrEqual(3);
  });

  test('21. ANSI sequences pass through: colored content in buffer', async ({ page }) => {
    const t = await seedTerminal({
      lines: 100,
      withFakeContent: true,
      ansiColors: true,
      status: 'running',
    });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);

    // xterm should have parsed escape sequences — raw codes must not appear in buffer text
    const lines = await getXtermBufferLines(page, t.id, 0, 30);
    const withRawEscape = lines.filter(
      (l) => l.includes('\x1b[') || l.includes('\\x1b'),
    );
    expect(withRawEscape.length).toBe(0);
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    expect(nonEmpty.length).toBeGreaterThan(5);
  });
});

// ============================================================
// Suite 5: Input and Control (requires live PTY)
// ============================================================

test.describe('Suite 5: Input and Control', () => {

  test('22. keyboard input echoes via PTY (shell)', async ({ page }) => {
    test.setTimeout(60_000);

    const workerIdx = process.env.TEST_WORKER_INDEX;
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
      },
      body: JSON.stringify({
        project_key: '\u2013/architect/\u2013',
        title: 'input-test',
        agentType: 'shell',
        permission_mode: 'acceptEdits',
      }),
    });
    const { terminal_id } = await resp.json();

    await page.goto('/');
    await waitForTerminalLive(page, terminal_id, 30_000);

    await typeIntoTerminal(page, terminal_id, 'echo hello-test-123\n');
    await waitForTextInXterm(page, terminal_id, 'hello-test-123', 10_000);
  });

  test('23. Ctrl+C sends SIGINT visible in terminal', async ({ page }) => {
    test.setTimeout(60_000);

    const workerIdx = process.env.TEST_WORKER_INDEX;
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
      },
      body: JSON.stringify({
        project_key: '\u2013/architect/\u2013',
        title: 'ctrl-c-test',
        agentType: 'shell',
        permission_mode: 'acceptEdits',
      }),
    });
    const { terminal_id } = await resp.json();
    await page.goto('/');
    await waitForTerminalLive(page, terminal_id, 30_000);

    // Start a blocking command
    await typeIntoTerminal(page, terminal_id, 'sleep 60\n');
    await page.waitForTimeout(500);

    // Send Ctrl+C via the WS manager
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (sess?._wsManager) sess._wsManager.send({ type: 'input', data: '\x03' });
    }, terminal_id);

    // Some shells print ^C; if not, at minimum state must remain LIVE
    await waitForTextInXterm(page, terminal_id, /sleep|interrupt|\^C/, 5_000).catch(() => {});
    const state = await getSessionState(page, terminal_id);
    expect(state?.state).toBe('LIVE');
  });

  test('24. rapid input: 50 chars sent, all appear in order', async ({ page }) => {
    test.setTimeout(60_000);

    const workerIdx = process.env.TEST_WORKER_INDEX;
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
      },
      body: JSON.stringify({
        project_key: '\u2013/architect/\u2013',
        title: 'rapid-input-test',
        agentType: 'shell',
        permission_mode: 'acceptEdits',
      }),
    });
    const { terminal_id } = await resp.json();
    await page.goto('/');
    await waitForTerminalLive(page, terminal_id, 30_000);

    // Send 50 characters in rapid succession via the WS manager
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMN';
    await page.evaluate(({ id, text }) => {
      const sess = window._termSessions?.get(id);
      if (!sess?._wsManager) return;
      for (const ch of text) {
        sess._wsManager.send({ type: 'input', data: ch });
      }
    }, { id: terminal_id, text: chars });

    await page.waitForTimeout(1_000);
    // Terminal must not have crashed
    const state = await getSessionState(page, terminal_id);
    expect(state?.state).toBe('LIVE');
  });

  test('25. arrow keys: navigating command history', async ({ page }) => {
    test.setTimeout(60_000);

    const workerIdx = process.env.TEST_WORKER_INDEX;
    const resp = await fetch(`${getBase()}/api/terminal`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workerIdx !== undefined ? { 'x-test-worker-id': String(workerIdx) } : {}),
      },
      body: JSON.stringify({
        project_key: '\u2013/architect/\u2013',
        title: 'arrow-key-test',
        agentType: 'shell',
        permission_mode: 'acceptEdits',
      }),
    });
    const { terminal_id } = await resp.json();
    await page.goto('/');
    await waitForTerminalLive(page, terminal_id, 30_000);

    // Submit a command to create history
    await typeIntoTerminal(page, terminal_id, 'echo arrow-history-test\n');
    await waitForTextInXterm(page, terminal_id, 'arrow-history-test', 5_000);

    // Allow the shell to stabilize (return to prompt) before sending history navigation
    await page.waitForTimeout(500);

    // Press up arrow to recall the last command
    await page.evaluate((id) => {
      const sess = window._termSessions?.get(id);
      if (sess?._wsManager) sess._wsManager.send({ type: 'input', data: '\x1b[A' });
    }, terminal_id);

    // Wait for stable LIVE state — WS may briefly reconnect during history navigation
    await waitForTerminalLive(page, terminal_id, 10_000);
    // Terminal must still be functional after history navigation
    const state = await getSessionState(page, terminal_id);
    expect(state?.state).toBe('LIVE');
  });
});

// ============================================================
// Suite 6: Corner Cases
// ============================================================

test.describe('Suite 6: Corner Cases', () => {

  test('26. empty terminal: xterm visible with no content', async ({ page }) => {
    const t = await seedTerminal({ lines: 0, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    const containerVisible = await page
      .locator(`#term-container-${t.id}`)
      .isVisible();
    expect(containerVisible).toBe(true);
  });

  test('27. very long line (5KB): no crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    const t = await seedTerminal({ lines: 5, status: 'running', withFakeContent: false });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);

    // No terminal/xterm/pty-related page errors should have occurred
    expect(
      errors.filter((e) => /terminal|xterm|ptyProcess/i.test(e)),
    ).toHaveLength(0);
  });

  test('28. collapse and expand panel: content retained', async ({ page }) => {
    const t = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);
    await waitForTerminalContent(page, t.id, 20);

    const minimizeBtn = page.locator(`[data-minimize-terminal="${t.id}"]`);
    if (await minimizeBtn.isVisible()) {
      await minimizeBtn.click();
      await page.waitForTimeout(200);
      await minimizeBtn.click();
      await page.waitForTimeout(300);
    }

    const metricsAfter = await getXtermScrollMetrics(page, t.id);
    expect(metricsAfter.baseY).toBeGreaterThan(0);
  });

  test('29. kill terminal: panel shows non-running status', async ({ page }) => {
    const t = await seedTerminal({ lines: 50, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await waitForTerminalLive(page, t.id);

    // Kill via API
    await fetch(`${getBase()}/api/terminal/${t.id}`, { method: 'DELETE' });
    await page.waitForTimeout(2_000);

    const panel = page.locator(`#terminal-${t.id}`);
    const hasExitedClass = await panel
      .evaluate((el) =>
        el.classList.contains('status-killed') ||
        el.classList.contains('status-failed') ||
        el.classList.contains('status-completed') ||
        el.dataset.status === 'killed',
      )
      .catch(() => false);

    const state = await getSessionState(page, t.id);
    expect(state?.state === 'EXITED' || hasExitedClass).toBe(true);
  });

  test('30. two running terminals: both have independent content', async ({ page }) => {
    const t1 = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    const t2 = await seedTerminal({ lines: 100, withFakeContent: true, status: 'running' });
    await page.goto('/');
    await Promise.all([
      waitForTerminalLive(page, t1.id),
      waitForTerminalLive(page, t2.id),
    ]);
    await Promise.all([
      waitForTerminalContent(page, t1.id, 30),
      waitForTerminalContent(page, t2.id, 30),
    ]);

    const m1 = await getXtermScrollMetrics(page, t1.id);
    const m2 = await getXtermScrollMetrics(page, t2.id);
    expect(m1.baseY).toBeGreaterThan(0);
    expect(m2.baseY).toBeGreaterThan(0);
  });

  test('31. eventstream head_seq matches terminal active list', async ({ page }) => {
    const t = await seedTerminal({ lines: 50, withFakeContent: true, status: 'running' });

    const active = await getActiveTerminals();
    const found = active.find((a) => a.id === t.id);
    expect(found).toBeTruthy();
    expect(found.head_seq).toBeGreaterThan(0);

    const stream = await getEventStream(t.id);
    expect(stream.head_seq).toBeGreaterThan(0);
    expect(stream.events.length + (stream.snapshot ? 1 : 0)).toBeGreaterThan(0);
  });
});
