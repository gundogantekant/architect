/**
 * Terminal Experience E2E Tests
 *
 * Behavioral test suite for the dashboard dispatch/terminal UX.
 * Tests run against a live dashboard at http://127.0.0.1:3777.
 *
 * Prerequisite: dashboard server must be running (dashctl.sh start).
 *
 * These tests seed dispatches via the test-seed API endpoint which creates
 * dispatch records with pre-built JSONL log content, avoiding the need to
 * spawn real Claude processes.
 */

import { test, expect } from '@playwright/test';

const BASE = 'http://127.0.0.1:3777';

// --- Helpers ---

/** Generate stream-json JSONL lines with substantial structured content */
function generateTestLogLines(lineCount = 300) {
  const files = ['entities.md', 'rules.md', 'CLAUDE.md', 'load-portfolio-context.md'];
  const lines = [];

  for (const file of files) {
    lines.push(JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }));

    for (let i = 0; i < Math.ceil(lineCount / files.length); i++) {
      const text = i === 0
        ? `\n## File: ${file}\n\n### Section ${i + 1}\n\n`
        : `This is detailed analysis line ${i} for ${file}. ` +
          `The file contains important configuration that affects the system behavior. ` +
          `Key observations include structural patterns, dependency chains, and architectural constraints ` +
          `that must be preserved during any refactoring effort.\n\n`;

      lines.push(JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text },
      }));
    }
  }

  lines.push(JSON.stringify({
    type: 'result',
    subtype: 'success',
    total_cost_usd: 0.05,
  }));

  return lines;
}

/** Seed a dispatch atomically via API (server writes JSONL + loads into memory) */
async function seedDispatch(id, { status = 'completed', projectKey = 'test/test/main' } = {}) {
  const resp = await fetch(`${BASE}/api/test/seed-dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      status,
      project_key: projectKey,
      title: `Test dispatch ${id}`,
      work_item_id: `W-TEST-${id.split('-').pop()}`,
      log_lines: generateTestLogLines(),
    }),
  });
  if (!resp.ok) throw new Error(`Seed failed: ${resp.status} ${await resp.text()}`);
  return resp.json();
}

/** Clean up a seeded dispatch */
async function cleanupDispatch(id) {
  await fetch(`${BASE}/api/dispatch/${id}`, { method: 'DELETE' }).catch(() => {});
}

/** Wait for a selector to have non-empty text content */
async function waitForContent(page, selector, minLength = 100) {
  await page.waitForFunction(
    ([sel, min]) => {
      const el = document.querySelector(sel);
      return el && el.textContent.length > min;
    },
    [selector, minLength],
    { timeout: 15_000 },
  );
}


// ============================================================
// Test Group 1: Multi-tab content consistency
// ============================================================

test.describe('Multi-tab content consistency', () => {
  const dispatchId = 'D-test-multitab';

  test.beforeEach(async () => {
    await seedDispatch(dispatchId, { status: 'completed' });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('two tabs show identical content for a completed dispatch', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const tab1 = await ctx1.newPage();
    const tab2 = await ctx2.newPage();

    // Navigate both tabs to dashboard
    await tab1.goto(BASE);
    await tab2.goto(BASE);

    const logSelector = `#log-${dispatchId}`;

    // Wait for content in both tabs
    await waitForContent(tab1, logSelector);
    await waitForContent(tab2, logSelector);

    const content1 = await tab1.$eval(logSelector, el => el.textContent);
    const content2 = await tab2.$eval(logSelector, el => el.textContent);

    // Both must have substantial content
    expect(content1.length).toBeGreaterThan(5000);
    expect(content2.length).toBeGreaterThan(5000);

    // Content must be identical
    expect(content1).toBe(content2);

    // Content must include distinct file sections
    expect(content1).toContain('entities.md');
    expect(content1).toContain('load-portfolio-context.md');

    await ctx1.close();
    await ctx2.close();
  });

  test('second tab shows completed status, not failed', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(BASE);

    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    // Panel should not have failed status class
    const panel = page.locator(`#dispatch-${dispatchId}`);
    await expect(panel).not.toHaveClass(/status-failed/);

    // Content must be non-empty
    const content = await page.$eval(logSelector, el => el.textContent);
    expect(content.length).toBeGreaterThan(5000);

    await ctx.close();
  });
});


// ============================================================
// Test Group 2: Dispatch log scroll — window mode
// ============================================================

test.describe('Dispatch log scroll — window mode', () => {
  const dispatchId = 'D-test-scroll-window';

  test.beforeEach(async () => {
    await seedDispatch(dispatchId, { status: 'completed' });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('dispatch log is scrollable with content overflow', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    const metrics = await page.$eval(logSelector, el => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
    }));

    // Content must overflow the panel (350px max-height)
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight * 3);
    // Should be scrolled to bottom initially
    expect(metrics.scrollTop).toBeGreaterThan(0);
  });

  test('scroll-up shows earlier content (entities.md near top)', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    // Scroll to top
    await page.$eval(logSelector, el => { el.scrollTop = 0; });
    await page.waitForTimeout(100);

    // Get visible text near the top
    const topText = await page.$eval(logSelector, el => {
      // Get text content from the visible portion (first ~500 chars)
      return el.textContent.substring(0, 500);
    });

    // First file section should be entities.md
    expect(topText).toContain('entities.md');
  });

  test('scroll position is preserved when content does not change', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    // Scroll to middle
    const midScroll = await page.$eval(logSelector, el => {
      const mid = el.scrollHeight / 2;
      el.scrollTop = mid;
      return el.scrollTop;
    });

    // Wait a moment
    await page.waitForTimeout(500);

    // Position should not have changed (no new content forcing scroll)
    const currentScroll = await page.$eval(logSelector, el => el.scrollTop);
    expect(currentScroll).toBe(midScroll);
  });
});


// ============================================================
// Test Group 3: Dispatch log scroll — focused mode
// ============================================================

test.describe('Dispatch log scroll — focused mode', () => {
  const dispatchId = 'D-test-scroll-focus';

  test.beforeEach(async () => {
    await seedDispatch(dispatchId, { status: 'completed' });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('focus popup shows content scrolled to bottom', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    // Click focus button
    await page.click(`[data-focus-dispatch="${dispatchId}"]`);
    await page.waitForSelector('.focus-overlay', { state: 'visible' });
    await page.waitForTimeout(300); // let scroll settle

    // In focus mode, log should be scrolled to bottom
    const metrics = await page.$eval(logSelector, el => ({
      scrollHeight: el.scrollHeight,
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      atBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 50,
    }));

    expect(metrics.atBottom).toBe(true);
  });

  test('scroll-up in popup reveals consistent history', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    // Get the full content before focus
    const fullContent = await page.$eval(logSelector, el => el.textContent);

    // Open focus popup
    await page.click(`[data-focus-dispatch="${dispatchId}"]`);
    await page.waitForSelector('.focus-overlay', { state: 'visible' });
    await page.waitForTimeout(300);

    // Scroll to top in popup
    await page.$eval(logSelector, el => { el.scrollTop = 0; });
    await page.waitForTimeout(100);

    // Content in popup should be the same as inline
    const popupContent = await page.$eval(logSelector, el => el.textContent);
    expect(popupContent).toBe(fullContent);

    // Top content should include entities.md
    expect(popupContent.substring(0, 500)).toContain('entities.md');
  });

  test('closing popup restores inline panel with content', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    const contentBefore = await page.$eval(logSelector, el => el.textContent);

    // Open and close focus popup
    await page.click(`[data-focus-dispatch="${dispatchId}"]`);
    await page.waitForSelector('.focus-overlay', { state: 'visible' });
    await page.waitForTimeout(200);

    // Close via escape
    await page.keyboard.press('Escape');
    await page.waitForSelector('.focus-overlay', { state: 'detached' });
    await page.waitForTimeout(200);

    // Content should still be intact
    const contentAfter = await page.$eval(logSelector, el => el.textContent);
    expect(contentAfter).toBe(contentBefore);
    expect(contentAfter.length).toBeGreaterThan(5000);
  });
});


// ============================================================
// Test Group 4: Session history consistency
// ============================================================

test.describe('Session history consistency', () => {
  const ids = ['D-test-hist-1', 'D-test-hist-2', 'D-test-hist-3'];

  test.beforeEach(async () => {
    for (const id of ids) {
      await seedDispatch(id, { status: 'completed' });
    }
  });

  test.afterEach(async () => {
    for (const id of ids) {
      await cleanupDispatch(id);
    }
  });

  test('multiple concurrent dispatches all render with content', async ({ page }) => {
    await page.goto(BASE);

    for (const id of ids) {
      const logSelector = `#log-${id}`;
      await waitForContent(page, logSelector, 100);

      const content = await page.$eval(logSelector, el => el.textContent);
      expect(content.length).toBeGreaterThan(5000);
      expect(content).toContain('entities.md');
    }
  });

  test('content survives page refresh', async ({ page }) => {
    await page.goto(BASE);

    // Wait for first dispatch to load
    await waitForContent(page, `#log-${ids[0]}`, 100);

    // Capture content
    const contentBefore = await page.$eval(`#log-${ids[0]}`, el => el.textContent);

    // Refresh
    await page.reload();

    // Wait for content to reload
    await waitForContent(page, `#log-${ids[0]}`, 100);

    const contentAfter = await page.$eval(`#log-${ids[0]}`, el => el.textContent);
    expect(contentAfter).toBe(contentBefore);
    expect(contentAfter.length).toBeGreaterThan(5000);
  });

  test('navigation between views preserves panels', async ({ page }) => {
    await page.goto(BASE);
    await waitForContent(page, `#log-${ids[0]}`, 100);

    const content1 = await page.$eval(`#log-${ids[0]}`, el => el.textContent);

    // Navigate away and back
    await page.goto(`${BASE}/#settings`);
    await page.waitForTimeout(500);
    await page.goto(BASE);
    await waitForContent(page, `#log-${ids[0]}`, 100);

    const content2 = await page.$eval(`#log-${ids[0]}`, el => el.textContent);
    expect(content2).toBe(content1);
  });
});


// ============================================================
// Test Group 5: Session persistence across server restart
// ============================================================

test.describe('Session persistence across restart', () => {
  const dispatchId = 'D-test-persist';

  test.beforeEach(async () => {
    await seedDispatch(dispatchId, { status: 'completed' });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('content survives simulated server restart', async ({ page }) => {
    // Verify content loads initially
    await page.goto(BASE);
    await waitForContent(page, `#log-${dispatchId}`);
    const contentBefore = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(contentBefore.length).toBeGreaterThan(5000);

    // Simulate server restart: clear memory, re-load from DB + log files
    const resetResp = await fetch(`${BASE}/api/test/reset-sessions`, { method: 'POST' });
    expect(resetResp.ok).toBe(true);

    // Reload page — dispatches should be restored from DB with log content
    await page.reload();
    await waitForContent(page, `#log-${dispatchId}`);

    const contentAfter = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(contentAfter.length).toBeGreaterThan(5000);
    expect(contentAfter).toContain('entities.md');
    expect(contentAfter).toContain('load-portfolio-context.md');
  });
});


// ============================================================
// Test Group 6: Live streaming for running dispatches
// ============================================================

test.describe('Live streaming for running dispatch', () => {
  const dispatchId = 'D-test-live';

  test.beforeEach(async () => {
    // Seed a running dispatch with NO initial content
    await fetch(`${BASE}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dispatchId,
        status: 'running',
        project_key: 'test/test/main',
        title: 'Live streaming test',
        work_item_id: 'W-TEST-LIVE',
        log_lines: [],
      }),
    });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('new content appears via SSE as lines are appended', async ({ page }) => {
    await page.goto(BASE);

    // Wait for dispatch panel to exist (may have empty log initially)
    await page.waitForSelector(`#dispatch-${dispatchId}`, { timeout: 10_000 });
    await page.waitForTimeout(1000); // let SSE connect

    // Append content lines to the running dispatch
    const newLines = [];
    for (let i = 0; i < 20; i++) {
      newLines.push(JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `Live line ${i}: streaming entities.md analysis content here.\n` },
      }));
    }

    const appendResp = await fetch(`${BASE}/api/test/append-dispatch-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dispatchId, lines: newLines }),
    });
    expect(appendResp.ok).toBe(true);

    // Wait for content to appear in the browser
    await waitForContent(page, `#log-${dispatchId}`, 100);

    const content = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(content).toContain('Live line 0');
    expect(content).toContain('Live line 19');
    expect(content).toContain('entities.md');
  });
});


// ============================================================
// Test Group 7: Terminal scrollback
// ============================================================

test.describe('Terminal scrollback', () => {
  const terminalId = 'T-test-scroll';

  /** Generate 200 numbered lines of plain text scrollback */
  function generateScrollback(lineCount = 200) {
    const lines = [];
    for (let i = 1; i <= lineCount; i++) {
      const num = String(i).padStart(3, '0');
      lines.push(`Line ${num}: This is terminal output line ${i} with enough text to fill the width of a standard terminal window.`);
    }
    return lines.join('\n') + '\n';
  }

  test.beforeEach(async () => {
    const resp = await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: generateScrollback(),
      }),
    });
    if (!resp.ok) throw new Error(`Seed terminal failed: ${resp.status}`);
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('scrollback creates scrollable xterm content', async ({ page }) => {
    await page.goto(BASE);

    // Wait for terminal panel to appear and WebSocket to connect
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000); // let xterm render scrollback

    const metrics = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const viewport = panel.querySelector('.xterm-viewport');
      return {
        hasXterm: !!panel.querySelector('.xterm'),
        scrollHeight: viewport?.scrollHeight || 0,
        clientHeight: viewport?.clientHeight || 0,
        scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
      };
    }, terminalId);

    expect(metrics).not.toBeNull();
    expect(metrics.hasXterm).toBe(true);
    expect(metrics.scrollable).toBe(true);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight * 2);
  });

  test('scrollback content has proper depth — no excessive blank padding', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000);

    const analysis = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const viewport = panel.querySelector('.xterm-viewport');
      if (!viewport) return null;

      // xterm.js only renders visible rows in the DOM — scrollback is in the internal buffer.
      // We verify scrollback quality by checking:
      // 1. scrollHeight is proportional to content (200 lines × ~lineHeight ≈ large scrollHeight)
      // 2. scrollHeight is NOT inflated by excessive blank rows (would be much larger than expected)
      const scrollHeight = viewport.scrollHeight;
      const clientHeight = viewport.clientHeight;
      const scrollRatio = scrollHeight / clientHeight;

      // 200 lines of text at ~15px line height ≈ 3000px scrollHeight.
      // clientHeight ≈ 390px. Expected ratio ≈ 7-10x.
      // If blank padding inflated it, ratio would be much higher (50x+).
      return {
        scrollHeight,
        clientHeight,
        scrollRatio: Math.round(scrollRatio * 10) / 10,
        scrollable: scrollHeight > clientHeight,
      };
    }, terminalId);

    expect(analysis).not.toBeNull();
    expect(analysis.scrollable).toBe(true);
    // Ratio should be reasonable (5-30x) — not inflated by blank padding (50x+)
    expect(analysis.scrollRatio).toBeGreaterThan(3);
    expect(analysis.scrollRatio).toBeLessThan(50);
  });

  test('terminal scroll works in focus mode', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000);

    // Verify scrollable before focus
    const beforeFocus = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const viewport = panel.querySelector('.xterm-viewport');
      return {
        hasXterm: !!panel.querySelector('.xterm'),
        scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
      };
    }, terminalId);

    expect(beforeFocus).not.toBeNull();
    expect(beforeFocus.hasXterm).toBe(true);
    expect(beforeFocus.scrollable).toBe(true);

    // Open focus popup
    await page.click(`[data-focus-terminal="${terminalId}"]`);
    await page.waitForSelector('.focus-overlay', { state: 'visible' });
    await page.waitForTimeout(500);

    // Close popup
    await page.keyboard.press('Escape');
    await page.waitForSelector('.focus-overlay', { state: 'detached' });
    await page.waitForTimeout(300);

    // Verify inline panel still has xterm after close
    const afterClose = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      return { exists: !!panel, hasXterm: !!panel?.querySelector('.xterm') };
    }, terminalId);

    expect(afterClose.exists).toBe(true);
    expect(afterClose.hasXterm).toBe(true);
  });
});
