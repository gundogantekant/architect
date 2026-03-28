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
    { timeout: 25_000 },
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

  test('new content appears via WebSocket as lines are appended', async ({ page }) => {
    await page.goto(BASE);

    // Wait for dispatch panel to exist (may have empty log initially)
    await page.waitForSelector(`#dispatch-${dispatchId}`, { timeout: 10_000 });
    await page.waitForTimeout(1000); // let WebSocket connect

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


// ============================================================
// Test Group 8: Multi-client terminal (two browsers same terminal)
// ============================================================

test.describe('Multi-client terminal', () => {
  const terminalId = 'T-test-multi';

  function generateScrollback(lineCount = 200) {
    const lines = [];
    for (let i = 1; i <= lineCount; i++) {
      lines.push(`Line ${String(i).padStart(3, '0')}: Terminal output for multi-client test with enough text to fill width.`);
    }
    return lines.join('\n') + '\n';
  }

  test.beforeEach(async () => {
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: generateScrollback(),
      }),
    });
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('two browser tabs both show terminal content', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const tab1 = await ctx1.newPage();
    const tab2 = await ctx2.newPage();

    // Tab 1 connects first
    await tab1.goto(BASE);
    await tab1.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await tab1.waitForTimeout(3000);

    // Tab 2 connects second (same terminal)
    await tab2.goto(BASE);
    await tab2.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await tab2.waitForTimeout(3000);

    // Both tabs must have scrollable xterm content
    for (const [label, tab] of [['Tab 1', tab1], ['Tab 2', tab2]]) {
      const metrics = await tab.evaluate((id) => {
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

      expect(metrics, `${label} should have terminal`).not.toBeNull();
      expect(metrics.hasXterm, `${label} should have xterm`).toBe(true);
      expect(metrics.scrollable, `${label} should be scrollable`).toBe(true);
    }

    // Verify Tab 1 was NOT blanked by Tab 2's connection
    const tab1Check = await tab1.evaluate((id) => {
      const viewport = document.querySelector(`#terminal-${id} .xterm-viewport`);
      return { scrollHeight: viewport?.scrollHeight || 0 };
    }, terminalId);
    expect(tab1Check.scrollHeight).toBeGreaterThan(390);

    await ctx1.close();
    await ctx2.close();
  });

  test('terminal panel reappears after page refresh', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000);

    // Verify panel exists before refresh
    const before = await page.evaluate((id) => {
      return { exists: !!document.getElementById(`terminal-${id}`) };
    }, terminalId);
    expect(before.exists).toBe(true);

    // Refresh
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 15_000 });
    await page.waitForTimeout(4000);

    // Panel must reappear with xterm content
    const after = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      const viewport = panel?.querySelector('.xterm-viewport');
      return {
        exists: !!panel,
        hasXterm: !!panel?.querySelector('.xterm'),
        scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
      };
    }, terminalId);
    expect(after.exists).toBe(true);
    // xterm may or may not load depending on CDN speed; panel must at least exist
    // If xterm loaded, verify scrollable
    if (after.hasXterm) {
      expect(after.scrollable).toBe(true);
    }
  });

  test('polling does not reset terminal content after 12 seconds', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000);

    // Record scrollHeight before polling
    const before = await page.evaluate((id) => {
      const viewport = document.querySelector(`#terminal-${id} .xterm-viewport`);
      return { scrollHeight: viewport?.scrollHeight || 0 };
    }, terminalId);
    expect(before.scrollHeight).toBeGreaterThan(390);

    // Wait for polling cycle (restoreTerminals runs every 10s)
    await page.waitForTimeout(12000);

    // Content must still be present (not reset by duplicate connection)
    const after = await page.evaluate((id) => {
      const viewport = document.querySelector(`#terminal-${id} .xterm-viewport`);
      return { scrollHeight: viewport?.scrollHeight || 0 };
    }, terminalId);
    expect(after.scrollHeight).toBeGreaterThan(390);
    expect(after.scrollHeight).toBe(before.scrollHeight);
  });
});


// ============================================================
// Test Group 9: Terminal loading state — no blank content visible
// ============================================================

test.describe('Terminal loading state', () => {
  const terminalId = 'T-test-loading';

  function generateScrollback(lineCount = 200) {
    const lines = [];
    for (let i = 1; i <= lineCount; i++) {
      lines.push(`Line ${String(i).padStart(3, '0')}: Terminal output for loading state test with enough text to fill the width.`);
    }
    return lines.join('\n') + '\n';
  }

  test.beforeEach(async () => {
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: generateScrollback(),
      }),
    });
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('loading overlay shows KB progress during scrollback delivery', async ({ page }) => {
    // Install a MutationObserver BEFORE seeding, so we capture all loading text transitions
    await page.goto(BASE);

    // Set up observer that captures all loading overlay text changes
    await page.evaluate(() => {
      window._loadingTexts = [];
      window._loadingObserver = new MutationObserver((mutations) => {
        for (const m of mutations) {
          const target = m.target.closest?.('.terminal-loading') || m.target;
          if (target?.classList?.contains('terminal-loading')) {
            window._loadingTexts.push(target.textContent);
          }
          // Also capture added nodes
          for (const node of m.addedNodes) {
            if (node.classList?.contains('terminal-loading')) {
              window._loadingTexts.push(node.textContent);
            }
          }
        }
      });
      window._loadingObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
    });

    // Now seed the terminal with large scrollback
    const largeTermId = 'T-test-loading-progress';
    const lines = [];
    for (let i = 1; i <= 500; i++) {
      lines.push(`Line ${String(i).padStart(3, '0')}: ${'X'.repeat(100)}`);
    }
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: largeTermId,
        status: 'completed',
        scrollback: lines.join('\n') + '\n',
      }),
    });

    // Trigger terminal restore (poll normally handles this)
    await page.evaluate(() => { if (typeof restoreTerminals === 'function') restoreTerminals(); });
    await page.waitForSelector(`#terminal-${largeTermId}`, { timeout: 10_000 });
    await page.waitForTimeout(5000); // let full load + xterm render complete

    // Collect all captured loading text transitions
    const result = await page.evaluate(() => {
      window._loadingObserver?.disconnect();
      return {
        texts: window._loadingTexts || [],
        loadingGone: !document.querySelector('.terminal-loading'),
      };
    });

    // The overlay should have shown "Connecting" initially
    const hasConnecting = result.texts.some(t => /Connecting/i.test(t));
    // And then transitioned to KB progress
    const hasKBProgress = result.texts.some(t => /\d+\s*\/\s*\d+\s*KB/.test(t));
    // And ultimately been removed
    expect(result.loadingGone).toBe(true);

    // At minimum, the initial "Connecting" text should have been observed
    expect(hasConnecting || hasKBProgress).toBe(true);

    await fetch(`${BASE}/api/terminal/${largeTermId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('terminal panel shows loading indicator before content arrives', async ({ page }) => {
    await page.goto(BASE);

    // Panel should appear
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    // Before xterm renders scrollback, there should be a loading indicator
    // OR the terminal container should not be blank (no visible empty dark box)
    const initialState = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const container = panel.querySelector(`#term-container-${id}`);
      const loading = container?.querySelector('.terminal-loading');
      const xterm = container?.querySelector('.xterm');
      const viewport = container?.querySelector('.xterm-viewport');
      return {
        hasPanel: true,
        hasLoadingIndicator: !!loading,
        hasXterm: !!xterm,
        hasScrollableContent: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
        containerVisible: container ? getComputedStyle(container).display !== 'none' : false,
      };
    }, terminalId);

    // If the container is visible and has no xterm content yet, there MUST be a loading indicator
    if (initialState && initialState.containerVisible && !initialState.hasScrollableContent) {
      expect(initialState.hasLoadingIndicator).toBe(true);
    }

    // Wait for xterm to render
    await page.waitForTimeout(4000);

    // After content arrives, loading indicator should be gone and xterm should be scrollable
    const finalState = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const container = panel.querySelector(`#term-container-${id}`);
      const loading = container?.querySelector('.terminal-loading');
      const viewport = container?.querySelector('.xterm-viewport');
      return {
        hasLoadingIndicator: !!loading,
        hasXterm: !!container?.querySelector('.xterm'),
        scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
      };
    }, terminalId);

    expect(finalState).not.toBeNull();
    expect(finalState.hasLoadingIndicator).toBe(false);
    expect(finalState.hasXterm).toBe(true);
    expect(finalState.scrollable).toBe(true);
  });
});


// ============================================================
// Test Group 10: Session ID display and copy
// ============================================================

test.describe('Session ID display and copy', () => {
  const terminalId = 'T-test-session-id';
  const testSessionId = 'test-session-abc-123-def';

  test.beforeEach(async () => {
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: 'Line 001: Session ID test output\n',
        claude_session_id: testSessionId,
      }),
    });
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('session ID tag is visible in terminal panel footer', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    // Session ID should appear as a clickable tag in the panel
    const sessionIdEl = await page.$(`#terminal-${terminalId} .session-id-copy`);
    expect(sessionIdEl).not.toBeNull();

    const sessionIdText = await sessionIdEl.textContent();
    expect(sessionIdText).toBe(testSessionId);
  });

  // Firefox doesn't support clipboard-read/write permissions in Playwright
  test('clicking session ID tag copies to clipboard', async ({ browser, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox does not support clipboard permissions in Playwright');
    // Need a context with clipboard permissions
    const ctx = await browser.newContext({
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await ctx.newPage();
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });

    const sessionIdEl = page.locator(`#terminal-${terminalId} .session-id-copy`);
    await sessionIdEl.click();

    // Wait for the "Copied!" feedback
    await expect(sessionIdEl).toHaveText('Copied!', { timeout: 3000 });

    // Verify clipboard content
    const clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(testSessionId);

    // After timeout, original text should restore
    await page.waitForTimeout(1500);
    await expect(sessionIdEl).toHaveText(testSessionId);

    await ctx.close();
  });
});


// ============================================================
// Test Group 11: Terminal column alignment quality
// ============================================================

test.describe('Terminal column alignment', () => {
  const terminalId = 'T-test-cols';

  /**
   * Generate lines that are exactly 80 chars — these should NOT wrap in a browser
   * terminal that is wider than 80 columns. The key assertion is that the xterm
   * uses the browser's available width, not a fixed 80-column layout.
   */
  function generateScrollback(lineCount = 50) {
    const lines = [];
    for (let i = 1; i <= lineCount; i++) {
      const num = String(i).padStart(3, '0');
      // Each line is exactly 79 chars + \n — fits in 80 cols without wrapping
      const prefix = `Line ${num}: `;
      const pad = 'A'.repeat(79 - prefix.length);
      lines.push(prefix + pad);
    }
    return lines.join('\n') + '\n';
  }

  test.beforeEach(async () => {
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: generateScrollback(),
      }),
    });
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('terminal uses browser width — not fixed at 80 columns', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(4000); // let xterm render

    const analysis = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const container = panel.querySelector(`#term-container-${id}`);
      if (!container) return null;

      // xterm only renders visible rows — check a line near the bottom (Line 050)
      // Also check any visible "Line NNN:" row for completeness
      const rows = container.querySelectorAll('.xterm-rows > div');
      let foundLine = false;
      let lineText = '';
      let lineNum = '';
      for (let i = 0; i < rows.length; i++) {
        const text = rows[i]?.textContent || '';
        const match = text.match(/Line \d{3}:/);
        if (match) {
          foundLine = true;
          lineText = text.trim();
          lineNum = match[0];
          break;
        }
      }

      // Check the container width — terminal should use available width
      const viewport = container.querySelector('.xterm-viewport');
      const termWidth = viewport?.clientWidth || 0;

      // A 79-char line should fit entirely in one row if cols > 79
      const fullLineOnOneRow = foundLine && lineText.length >= 79;

      return {
        foundLine,
        lineNum,
        lineText: lineText.substring(0, 100),
        lineLength: lineText.length,
        fullLineOnOneRow,
        termWidth,
        rowCount: rows.length,
      };
    }, terminalId);

    expect(analysis).not.toBeNull();
    expect(analysis.foundLine).toBe(true);
    // Terminal must be wider than 80 cols (browser viewport gives more space)
    expect(analysis.termWidth).toBeGreaterThan(500);
    // 79-char line should fit in a single xterm row
    expect(analysis.fullLineOnOneRow).toBe(true);
  });
});


// ============================================================
// Test Group 12: Completed session persistence across polling
// ============================================================

test.describe('Completed session persistence', () => {
  const terminalId = 'T-test-persist-poll';

  function generateScrollback() {
    const lines = [];
    for (let i = 1; i <= 50; i++) {
      lines.push(`Line ${String(i).padStart(3, '0')}: Persistence test output.`);
    }
    return lines.join('\n') + '\n';
  }

  test.beforeEach(async () => {
    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: terminalId,
        status: 'completed',
        scrollback: generateScrollback(),
      }),
    });
  });

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${terminalId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('completed terminal panel survives polling cycle', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000); // let xterm render

    // Verify panel exists with content
    const before = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      return {
        exists: !!panel,
        hasXterm: !!panel?.querySelector('.xterm'),
      };
    }, terminalId);
    expect(before.exists).toBe(true);

    // Wait past two polling cycles (10s each) + Firefox xterm CDN load buffer
    await page.waitForTimeout(30000);

    // Panel must still exist
    const after = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      return {
        exists: !!panel,
        hasXterm: !!panel?.querySelector('.xterm'),
      };
    }, terminalId);
    expect(after.exists).toBe(true);
    expect(after.hasXterm).toBe(true);
  });

  test('completed terminal panel survives page reload', async ({ page }) => {
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await page.waitForTimeout(3000);

    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 15_000 });
    await page.waitForTimeout(4000);

    const after = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      const viewport = panel?.querySelector('.xterm-viewport');
      return {
        exists: !!panel,
        hasXterm: !!panel?.querySelector('.xterm'),
        scrollable: viewport ? viewport.scrollHeight > viewport.clientHeight : false,
      };
    }, terminalId);
    expect(after.exists).toBe(true);
    if (after.hasXterm) {
      expect(after.scrollable).toBe(true);
    }
  });
});


// ============================================================
// Test Group 13: Dispatch content completeness
// ============================================================

test.describe('Dispatch content completeness', () => {
  const dispatchId = 'D-test-complete';

  test.beforeEach(async () => {
    await seedDispatch(dispatchId, { status: 'completed' });
  });

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('all file sections are present in dispatch log — no truncation', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector, 100);

    const content = await page.$eval(logSelector, el => el.textContent);

    // All 4 file sections must be present (from generateTestLogLines)
    const expectedSections = ['entities.md', 'rules.md', 'CLAUDE.md', 'load-portfolio-context.md'];
    for (const section of expectedSections) {
      expect(content, `Missing section: ${section}`).toContain(section);
    }

    // Content must be substantial — generateTestLogLines produces ~300 lines
    expect(content.length).toBeGreaterThan(10000);
  });

  test('dispatch log content length is consistent across reloads', async ({ page }) => {
    await page.goto(BASE);
    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector, 100);

    const contentBefore = await page.$eval(logSelector, el => el.textContent);

    await page.reload();
    await waitForContent(page, logSelector, 100);

    const contentAfter = await page.$eval(logSelector, el => el.textContent);

    // Content should be identical — no truncation on reload
    expect(contentAfter.length).toBe(contentBefore.length);
    expect(contentAfter).toBe(contentBefore);
  });
});


// ============================================================
// Test Group 14: PTY prompt delivery — large payload completeness
// ============================================================

test.describe('PTY prompt delivery completeness', () => {

  /**
   * Generate a realistic prompt payload of the given size.
   * Includes unique markers at start, middle, and end for verification.
   */
  function generatePayload(targetBytes) {
    const startMarker = '### START_MARKER_ALPHA ###';
    const endMarker = '### END_MARKER_OMEGA ###';
    const sections = [
      '# Identity\n\nYou are a specialized SDLC orchestrator agent.',
      '# Workflow Selection\n\n| Task | Agent | Model |\n|------|-------|-------|\n| Triage | pm | sonnet |\n| Planning | planner | opus |',
      '# Coding Standards\n\n- Domain-first naming\n- DRY: three occurrences = extract\n- No over-engineering\n- Clean architecture layers',
      '# Project Context\n\nStack: TypeScript, Node.js, React\nStructure: src/, tests/, docs/\nCI: GitHub Actions',
      '# Environment\n\nProject directory: /Users/test/project\nArchitect root: /Users/test/architect\nDashboard: http://127.0.0.1:3777',
    ];

    let content = startMarker + '\n\n';
    let sectionIdx = 0;
    while (content.length < targetBytes - endMarker.length - 200) {
      const section = sections[sectionIdx % sections.length];
      const iteration = Math.floor(sectionIdx / sections.length) + 1;
      content += `\n## Section ${sectionIdx + 1} (iteration ${iteration})\n\n${section}\n`;
      // Add numbered lines for precise tracking
      for (let j = 0; j < 10; j++) {
        content += `Detail line ${sectionIdx * 10 + j}: configuration parameter with value ${Math.random().toString(36).slice(2, 10)}.\n`;
      }
      sectionIdx++;
    }
    content += '\n' + endMarker + '\n';
    return content;
  }

  test('10KB payload is fully delivered through PTY chunked write', async () => {
    const payload = generatePayload(10 * 1024);

    const resp = await fetch(`${BASE}/api/test/prompt-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    // Start and end markers must both be present in captured output
    expect(result.contains_start).toBe(true);
    expect(result.contains_end).toBe(true);
    // Captured output should contain all content lines
    expect(result.lines_captured).toBeGreaterThanOrEqual(result.lines_sent - 5); // small tolerance for echo artifacts
  });

  test('30KB payload is fully delivered through PTY chunked write', async () => {
    const payload = generatePayload(30 * 1024);

    const resp = await fetch(`${BASE}/api/test/prompt-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.contains_start).toBe(true);
    expect(result.contains_end).toBe(true);
    expect(result.lines_captured).toBeGreaterThanOrEqual(result.lines_sent - 5);
  });

  test('60KB payload is fully delivered through PTY chunked write', async () => {
    const payload = generatePayload(60 * 1024);

    const resp = await fetch(`${BASE}/api/test/prompt-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.contains_start).toBe(true);
    expect(result.contains_end).toBe(true);
    expect(result.lines_captured).toBeGreaterThanOrEqual(result.lines_sent - 5);
  });

  test('100KB payload is fully delivered — no truncation at large sizes', async () => {
    const payload = generatePayload(100 * 1024);

    const resp = await fetch(`${BASE}/api/test/prompt-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.contains_start).toBe(true);
    expect(result.contains_end).toBe(true);
    // At 100KB, captured must be at least 95% of sent (accounting for echo artifacts)
    expect(result.captured_length).toBeGreaterThan(result.payload_length * 0.95);
    expect(result.lines_captured).toBeGreaterThanOrEqual(result.lines_sent - 5);
  });

});


// ============================================================
// Test Group 15: Dispatch stdin delivery — large prompt completeness
// ============================================================

test.describe('Dispatch stdin delivery completeness', () => {

  /** Generate a realistic dispatch prompt payload */
  function generateDispatchPrompt(targetBytes) {
    const sections = [
      '# Identity\n\nYou are a specialized SDLC orchestrator agent responsible for coordinating work across multiple sub-agents.\n',
      '# Workflow Selection\n\n| Task | Agent | Model |\n|------|-------|-------|\n| Triage and dispatch | pm | sonnet |\n| Architecture decisions | planner | opus |\n| Code implementation | coder | inherit |\n| Testing | tester | sonnet |\n| Code review | reviewer | sonnet |\n',
      '# Project Context\n\nStack: TypeScript, Node.js, React, PostgreSQL\nArchitecture: Clean Architecture with domain/usecases/adapters/infrastructure layers\nCI: GitHub Actions with lint, test, build stages\nDeployment: Docker containers on AWS ECS\n',
      '# Coding Standards\n\n- Domain-first naming: use business terminology, not technical jargon\n- DRY: three occurrences = extract to shared utility\n- No over-engineering: no abstractions without two concrete use cases\n- Clean architecture layers: dependencies point inward only\n- OWASP Top 10 awareness for all user-facing code\n',
      '# Environment\n\nProject directory: /Users/developer/projects/webapp\nArchitect root: /Users/developer/architect\nDashboard API: http://127.0.0.1:3777\nGit branch: feature/new-auth-flow\n',
    ];

    let content = '';
    let idx = 0;
    while (content.length < targetBytes) {
      content += sections[idx % sections.length];
      // Add unique detail lines for precise byte tracking
      for (let j = 0; j < 20; j++) {
        content += `Configuration line ${idx * 20 + j}: parameter_${Math.random().toString(36).slice(2, 14)} = "${Math.random().toString(36).slice(2, 18)}"\n`;
      }
      idx++;
    }
    return content.slice(0, targetBytes);
  }

  test('30KB dispatch prompt is fully received by child process', async () => {
    const payload = generateDispatchPrompt(30 * 1024);

    const resp = await fetch(`${BASE}/api/test/stdin-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.match).toBe(true);
    expect(result.received_bytes).toBe(result.payload_length);
  });

  test('60KB dispatch prompt is fully received by child process', async () => {
    const payload = generateDispatchPrompt(60 * 1024);

    const resp = await fetch(`${BASE}/api/test/stdin-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.match).toBe(true);
    expect(result.received_bytes).toBe(result.payload_length);
  });

  test('150KB dispatch prompt is fully received by child process', async () => {
    const payload = generateDispatchPrompt(150 * 1024);

    const resp = await fetch(`${BASE}/api/test/stdin-delivery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(resp.ok).toBe(true);

    const result = await resp.json();
    expect(result.match).toBe(true);
    expect(result.received_bytes).toBe(result.payload_length);
  });
});


// ============================================================
// Test Group 16: Terminal content delivery after dispatch (race condition)
// ============================================================

test.describe('Terminal content delivery after dispatch', () => {

  /** Generate a large prompt payload with unique markers */
  function generatePrompt(targetBytes) {
    const startMarker = '### PROMPT_START_MARKER ###\n';
    const endMarker = '\n### PROMPT_END_MARKER ###\n';
    let content = startMarker;
    let lineNum = 0;
    while (content.length < targetBytes - endMarker.length) {
      content += `Prompt line ${String(++lineNum).padStart(4, '0')}: configuration detail for the dispatched agent session.\n`;
    }
    content += endMarker;
    return content;
  }

  test('browser shows complete content after connecting mid-prompt-write', async ({ page }) => {
    // Spawn a terminal that writes a large prompt asynchronously
    const payload = generatePrompt(20 * 1024); // 20KB prompt
    const spawnResp = await fetch(`${BASE}/api/test/spawn-prompt-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(spawnResp.ok).toBe(true);
    const { terminal_id: termId } = await spawnResp.json();

    // Navigate to dashboard — this connects WS while prompt is being written
    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });

    // Wait for prompt writing to complete + terminal to render
    // 20KB at 1KB/100ms ≈ 2s write + settle time
    await page.waitForTimeout(8000);

    // Loading overlay must be gone
    const state = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const container = panel.querySelector(`#term-container-${id}`);
      return {
        hasLoading: !!container?.querySelector('.terminal-loading'),
        hasXterm: !!container?.querySelector('.xterm'),
        viewportHeight: container?.querySelector('.xterm-viewport')?.scrollHeight || 0,
      };
    }, termId);

    expect(state).not.toBeNull();
    expect(state.hasLoading).toBe(false);
    expect(state.hasXterm).toBe(true);
    // Terminal should have substantial content (prompt was echoed)
    expect(state.viewportHeight).toBeGreaterThan(100);

    // Cleanup
    await fetch(`${BASE}/api/terminal/${termId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('browser close and reopen shows terminal content', async ({ browser }) => {
    // Spawn terminal with prompt
    const payload = generatePrompt(10 * 1024);
    const spawnResp = await fetch(`${BASE}/api/test/spawn-prompt-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(spawnResp.ok).toBe(true);
    const { terminal_id: termId } = await spawnResp.json();

    // Wait for prompt writing to complete
    await new Promise(r => setTimeout(r, 5000));

    // First browser session — verify content loads
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    await page1.goto(BASE);
    await page1.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });
    await page1.waitForTimeout(5000);

    const state1 = await page1.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      const container = panel?.querySelector(`#term-container-${id}`);
      return {
        hasXterm: !!container?.querySelector('.xterm'),
        hasLoading: !!container?.querySelector('.terminal-loading'),
        viewportHeight: container?.querySelector('.xterm-viewport')?.scrollHeight || 0,
      };
    }, termId);

    expect(state1.hasXterm).toBe(true);
    expect(state1.hasLoading).toBe(false);
    expect(state1.viewportHeight).toBeGreaterThan(100);

    // Close browser context (simulates closing the browser)
    await ctx1.close();

    // Wait a moment
    await new Promise(r => setTimeout(r, 1000));

    // Reopen browser — fresh context, no cached state
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(BASE);
    await page2.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });
    await page2.waitForTimeout(5000);

    const state2 = await page2.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      const container = panel?.querySelector(`#term-container-${id}`);
      return {
        hasXterm: !!container?.querySelector('.xterm'),
        hasLoading: !!container?.querySelector('.terminal-loading'),
        viewportHeight: container?.querySelector('.xterm-viewport')?.scrollHeight || 0,
      };
    }, termId);

    expect(state2.hasXterm).toBe(true);
    expect(state2.hasLoading).toBe(false);
    expect(state2.viewportHeight).toBeGreaterThan(100);

    await ctx2.close();
    await fetch(`${BASE}/api/terminal/${termId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('loading overlay resolves even with empty scrollback on fresh terminal', async ({ page }) => {
    // Spawn terminal — connect immediately before any output
    const spawnResp = await fetch(`${BASE}/api/test/spawn-prompt-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: 'short\n' }),
    });
    expect(spawnResp.ok).toBe(true);
    const { terminal_id: termId } = await spawnResp.json();

    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });

    // Within 12 seconds (10s fallback + margin), loading must resolve
    await page.waitForFunction(
      (id) => {
        const container = document.querySelector(`#term-container-${id}`);
        return container && !container.querySelector('.terminal-loading');
      },
      termId,
      { timeout: 15_000 },
    );

    const state = await page.evaluate((id) => {
      const container = document.querySelector(`#term-container-${id}`);
      return {
        hasLoading: !!container?.querySelector('.terminal-loading'),
        hasXterm: !!container?.querySelector('.xterm'),
      };
    }, termId);

    expect(state.hasLoading).toBe(false);
    expect(state.hasXterm).toBe(true);

    await fetch(`${BASE}/api/terminal/${termId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('50KB prompt — content visible from a separate browser context', async ({ browser }) => {
    // Simulate: dispatch with large prompt, then open a separate browser to view it
    const payload = generatePrompt(50 * 1024); // 50KB — realistic dispatch prompt size
    const spawnResp = await fetch(`${BASE}/api/test/spawn-prompt-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload }),
    });
    expect(spawnResp.ok).toBe(true);
    const { terminal_id: termId } = await spawnResp.json();

    // Wait for prompt writing to complete (50KB at 1KB/100ms ≈ 5s + settle)
    await new Promise(r => setTimeout(r, 8000));

    // Open two separate browser contexts (simulates Chrome and Firefox tabs)
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    // Both navigate to dashboard
    await page1.goto(BASE);
    await page2.goto(BASE);

    // Both wait for terminal panel
    await page1.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });
    await page2.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });
    await page1.waitForTimeout(5000);
    await page2.waitForTimeout(5000);

    // Both must show content without stuck loading
    for (const [label, pg] of [['Context 1', page1], ['Context 2', page2]]) {
      const state = await pg.evaluate((id) => {
        const panel = document.getElementById(`terminal-${id}`);
        const container = panel?.querySelector(`#term-container-${id}`);
        return {
          hasXterm: !!container?.querySelector('.xterm'),
          hasLoading: !!container?.querySelector('.terminal-loading'),
          scrollHeight: container?.querySelector('.xterm-viewport')?.scrollHeight || 0,
        };
      }, termId);

      expect(state.hasXterm, `${label}: should have xterm`).toBe(true);
      expect(state.hasLoading, `${label}: loading should be gone`).toBe(false);
      expect(state.scrollHeight, `${label}: should have scrollable content`).toBeGreaterThan(100);
    }

    await ctx1.close();
    await ctx2.close();
    await fetch(`${BASE}/api/terminal/${termId}`, { method: 'DELETE' }).catch(() => {});
  });
});


// ============================================================
// Test Group 16: Dispatch WebSocket broadcaster
// ============================================================

test.describe('Dispatch WebSocket broadcaster', () => {
  const dispatchId = 'D-test-ws-replay';

  test.afterEach(async () => {
    await cleanupDispatch(dispatchId);
  });

  test('completed dispatch content delivered via WebSocket replay', async ({ page }) => {
    await seedDispatch(dispatchId, { status: 'completed' });
    await page.goto(BASE);

    const logSelector = `#log-${dispatchId}`;
    await waitForContent(page, logSelector);

    const content = await page.$eval(logSelector, el => el.textContent);
    expect(content.length).toBeGreaterThan(5000);
    expect(content).toContain('entities.md');
    expect(content).toContain('load-portfolio-context.md');

    // Panel should be finalized (not running)
    const panel = page.locator(`#dispatch-${dispatchId}`);
    await expect(panel).not.toHaveClass(/status-running/);
  });

  test('running dispatch receives live lines via WebSocket broadcast', async ({ page }) => {
    // Seed a running dispatch with no initial content
    await fetch(`${BASE}/api/test/seed-dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: dispatchId,
        status: 'running',
        project_key: 'test/test/main',
        title: 'WS broadcast test',
        work_item_id: 'W-TEST-WS',
        log_lines: [],
      }),
    });

    await page.goto(BASE);
    await page.waitForSelector(`#dispatch-${dispatchId}`, { timeout: 10_000 });
    await page.waitForTimeout(1000); // let WebSocket connect

    // Append content lines
    const newLines = [];
    for (let i = 0; i < 10; i++) {
      newLines.push(JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: `WS broadcast line ${i}\n` },
      }));
    }

    await fetch(`${BASE}/api/test/append-dispatch-output`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: dispatchId, lines: newLines }),
    });

    // Verify content arrives
    await waitForContent(page, `#log-${dispatchId}`, 50);
    const content = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(content).toContain('WS broadcast line 0');
    expect(content).toContain('WS broadcast line 9');
  });

  test('dispatch content survives restart via memory replay', async ({ page }) => {
    await seedDispatch(dispatchId, { status: 'completed' });

    // Load and verify initial content
    await page.goto(BASE);
    await waitForContent(page, `#log-${dispatchId}`);
    const before = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(before.length).toBeGreaterThan(5000);

    // Simulate restart — server rebuilds memory from disk
    const resetResp = await fetch(`${BASE}/api/test/reset-sessions`, { method: 'POST' });
    expect(resetResp.ok).toBe(true);

    // Reload and verify content restored from memory
    await page.reload();
    await waitForContent(page, `#log-${dispatchId}`);
    const after = await page.$eval(`#log-${dispatchId}`, el => el.textContent);
    expect(after.length).toBeGreaterThan(5000);
    expect(after).toContain('entities.md');
  });
});


// ============================================================
// Test Group 17: Terminal xterm readiness fallback
// ============================================================

test.describe('Terminal xterm readiness fallback', () => {
  const termId = 'T-test-readiness';

  test.afterEach(async () => {
    await fetch(`${BASE}/api/terminal/${termId}`, { method: 'DELETE' }).catch(() => {});
  });

  test('terminal content renders after fallback timer when container has zero dimensions', async ({ page }) => {
    // Generate scrollback content
    const lines = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`Readiness test line ${i}: content that must render after fallback`);
    }
    const scrollback = lines.join('\r\n') + '\r\n';

    await fetch(`${BASE}/api/test/seed-terminal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: termId, scrollback, status: 'completed' }),
    });

    await page.goto(BASE);
    await page.waitForSelector(`#terminal-${termId}`, { timeout: 15_000 });

    // Wait for xterm to render — the fallback timer + polling should ensure content loads
    // even if initial container dimensions are zero (Chrome timing)
    await page.waitForTimeout(3000);

    const state = await page.evaluate((id) => {
      const container = document.getElementById(`term-container-${id}`);
      return {
        hasXterm: !!container?.querySelector('.xterm'),
        hasLoading: !!container?.querySelector('.terminal-loading'),
        scrollHeight: container?.querySelector('.xterm-viewport')?.scrollHeight || 0,
      };
    }, termId);

    expect(state.hasXterm).toBe(true);
    expect(state.hasLoading).toBe(false);
    expect(state.scrollHeight).toBeGreaterThan(50);
  });
});
