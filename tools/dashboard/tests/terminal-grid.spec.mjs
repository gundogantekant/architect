/**
 * Terminal Grid E2E Tests (TG-1 to TG-4)
 *
 * These tests define the behavioral contract for the responsive multi-column
 * terminal/dispatch grid introduced in W-944. The #dispatch-panels container
 * uses CSS grid with repeat(auto-fill, minmax(480px, 1fr)), so at wide
 * viewports two or more panels appear side-by-side, and at narrow viewports
 * they stack into a single column.
 *
 * TG-1: 3 terminals at wide viewport → at least 2 panels have different left positions
 * TG-2: 1 terminal → single panel is wide (not broken into tiny column)
 * TG-3: 2 terminals at 600px viewport → all panels have same left (single-column)
 * TG-4: 2 terminals at 1400px viewport → panels visible with non-zero height
 *
 * Test server started automatically by globalSetup on an isolated port.
 */

import { test, expect } from './fixtures.mjs';
import {
  seedTerminal,
  waitForTerminalLive,
  waitForTerminalContent,
} from './helpers.mjs';

const WIDE_VIEWPORT  = { width: 1400, height: 800 };
const NARROW_VIEWPORT = { width: 600, height: 800 };

test.beforeEach(async ({ page }) => {
  // Reset to a wide viewport before each test
  await page.setViewportSize(WIDE_VIEWPORT);
});

// ============================================================
// TG-1: multi-column layout at wide viewport
// ============================================================

test('TG-1: 3 terminals at wide viewport have at least 2 panels with different left positions', async ({ page }) => {
  const [t1, t2, t3] = await Promise.all([
    seedTerminal({ lines: 30, withFakeContent: true, status: 'running' }),
    seedTerminal({ lines: 30, withFakeContent: true, status: 'running' }),
    seedTerminal({ lines: 30, withFakeContent: true, status: 'running' }),
  ]);

  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/#agents');

  // Wait for all three panels to be in the DOM and live
  await Promise.all([
    page.waitForSelector(`#terminal-${t1.id}`, { timeout: 15000 }),
    page.waitForSelector(`#terminal-${t2.id}`, { timeout: 15000 }),
    page.waitForSelector(`#terminal-${t3.id}`, { timeout: 15000 }),
  ]);
  await page.waitForTimeout(400); // allow CSS grid reflow

  // Collect left positions of the 3 specific terminal panels
  const lefts = await page.evaluate(({ ids }) => {
    return ids.map((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      return Math.round(panel.getBoundingClientRect().left);
    }).filter((v) => v !== null);
  }, { ids: [t1.id, t2.id, t3.id] });

  // We need all 3 panels
  expect(lefts.length).toBeGreaterThanOrEqual(3);

  // At least two panels must have different left values — proves multi-column layout
  const uniqueLefts = [...new Set(lefts)];
  expect(uniqueLefts.length).toBeGreaterThanOrEqual(2);

  // The difference between min and max left must be >= 50px
  const minLeft = Math.min(...lefts);
  const maxLeft = Math.max(...lefts);
  expect(maxLeft - minLeft).toBeGreaterThanOrEqual(50);
});

// ============================================================
// TG-2: single terminal is not broken to tiny column
// ============================================================

test('TG-2: 1 terminal at wide viewport has panel width >= 300px', async ({ page }) => {
  const t = await seedTerminal({ lines: 30, withFakeContent: true, status: 'running' });

  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/#agents');
  await waitForTerminalLive(page, t.id);
  await page.waitForTimeout(300);

  const panelWidth = await page.evaluate((id) => {
    const panel = document.getElementById(`terminal-${id}`);
    if (!panel) return 0;
    return panel.getBoundingClientRect().width;
  }, t.id);

  expect(panelWidth).toBeGreaterThanOrEqual(300);
});

// ============================================================
// TG-3: narrow viewport forces single-column layout
// ============================================================

test('TG-3: 2 terminals at 600px viewport stack in single column (same left position)', async ({ page }) => {
  const [t1, t2] = await Promise.all([
    seedTerminal({ lines: 20, withFakeContent: true, status: 'running' }),
    seedTerminal({ lines: 20, withFakeContent: true, status: 'running' }),
  ]);

  await page.setViewportSize(NARROW_VIEWPORT);
  await page.goto('/#agents');

  // Wait for both panels to be in the DOM
  await Promise.all([
    page.waitForSelector(`#terminal-${t1.id}`, { timeout: 15000 }),
    page.waitForSelector(`#terminal-${t2.id}`, { timeout: 15000 }),
  ]);
  await page.waitForTimeout(300);

  // Collect left positions of the 2 specific terminal panels
  const lefts = await page.evaluate(({ ids }) => {
    return ids.map((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      return Math.round(panel.getBoundingClientRect().left);
    }).filter((v) => v !== null);
  }, { ids: [t1.id, t2.id] });

  expect(lefts.length).toBeGreaterThanOrEqual(2);

  // In single-column layout all panels share the same left position
  const uniqueLefts = [...new Set(lefts)];
  expect(uniqueLefts.length).toBe(1);
});

// ============================================================
// TG-4: panels are visible with non-zero height at wide viewport (xterm refit worked)
// ============================================================

test('TG-4: 2 terminals at 1400px viewport are visible with non-zero height', async ({ page }) => {
  const [t1, t2] = await Promise.all([
    seedTerminal({ lines: 30, withFakeContent: true, status: 'running' }),
    seedTerminal({ lines: 30, withFakeContent: true, status: 'running' }),
  ]);

  await page.setViewportSize(WIDE_VIEWPORT);
  await page.goto('/#agents');

  // Wait for panels to appear in DOM
  await Promise.all([
    page.waitForSelector(`#terminal-${t1.id}`, { timeout: 15000 }),
    page.waitForSelector(`#terminal-${t2.id}`, { timeout: 15000 }),
  ]);
  await page.waitForTimeout(300);

  // Both panels must be visible with non-zero height
  for (const t of [t1, t2]) {
    const box = await page.evaluate((id) => {
      const panel = document.getElementById(`terminal-${id}`);
      if (!panel) return null;
      const rect = panel.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }, t.id);

    expect(box).not.toBeNull();
    expect(box.height).toBeGreaterThan(0);
    expect(box.width).toBeGreaterThan(0);
  }
});
