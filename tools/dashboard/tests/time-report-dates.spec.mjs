/**
 * Time Report Date Format Tests (W-1290)
 *
 * TDD contract tests — written before the fix is applied.
 *
 * Root cause: getTimeReportDaily/ByOrg select `(sh.ended_at::timestamptz)::date AS day`,
 * which the pg driver (OID 1082) returns as a JS Date object. The frontend does
 * `d + 'T00:00:00'` expecting a YYYY-MM-DD string, producing "[object Date]T00:00:00"
 * → Invalid Date.
 *
 * TR-1 to TR-4: API contract — period columns must be plain strings in expected format.
 * TR-5 to TR-8: UI E2E — no "Invalid Date" text; column headers render valid formatted dates.
 */

import { test, expect } from './fixtures.mjs';
import { api, getBase, seedSessionHistory } from './helpers.mjs';

const DAY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_REGEX = /^\d{4}-\d{2}$/;

test.describe('Time report date format @fast', () => {

  // --- API contract tests ---

  test('TR-1: daily[].day values are YYYY-MM-DD strings', async () => {
    await seedSessionHistory({ project_key: 'tr1org/proj/main', duration_seconds: 120, cost_usd: 0.50 });
    const report = await api('time-report');
    expect(Array.isArray(report.daily)).toBe(true);
    for (const row of report.daily) {
      expect(typeof row.day, `day field must be a string, got ${typeof row.day}`).toBe('string');
      expect(row.day, `day "${row.day}" must match YYYY-MM-DD`).toMatch(DAY_REGEX);
    }
  });

  test('TR-2: monthly[].month values are YYYY-MM strings', async () => {
    await seedSessionHistory({ project_key: 'tr2org/proj/main', duration_seconds: 120, cost_usd: 0.50 });
    const report = await api('time-report');
    expect(Array.isArray(report.monthly)).toBe(true);
    for (const row of report.monthly) {
      expect(typeof row.month, `month field must be a string, got ${typeof row.month}`).toBe('string');
      expect(row.month, `month "${row.month}" must match YYYY-MM`).toMatch(MONTH_REGEX);
    }
  });

  test('TR-3: org-grouped daily[].day and monthly[].month are properly formatted strings', async () => {
    await seedSessionHistory({ project_key: 'tr3org/proj/main', duration_seconds: 180, cost_usd: 0.75 });
    const report = await api('time-report?group=org');
    for (const row of report.daily) {
      expect(typeof row.day).toBe('string');
      expect(row.day).toMatch(DAY_REGEX);
    }
    for (const row of report.monthly) {
      expect(typeof row.month).toBe('string');
      expect(row.month).toMatch(MONTH_REGEX);
    }
  });

  test('TR-4: no daily or monthly row has null/undefined period key', async () => {
    await seedSessionHistory({ project_key: 'tr4org/proj/main', duration_seconds: 60, cost_usd: 0.25 });
    const report = await api('time-report');
    for (const row of report.daily) {
      expect(row.day).not.toBeNull();
      expect(row.day).not.toBeUndefined();
    }
    for (const row of report.monthly) {
      expect(row.month).not.toBeNull();
      expect(row.month).not.toBeUndefined();
    }
  });

});

test.describe('Time report UI date rendering', () => {

  test('TR-5: Daily (14d) tab renders no "Invalid Date" text', async ({ page }) => {
    await seedSessionHistory({ project_key: 'tr5org/proj/main', duration_seconds: 300, cost_usd: 1.00 });
    await page.goto('/#time-report');
    await page.waitForSelector('#tr-tabs', { timeout: 10000 });

    const dailyTab = page.locator('#tr-tabs .tab', { hasText: 'Daily (14d)' });
    await dailyTab.click();
    await page.waitForTimeout(500);

    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Invalid Date');
  });

  test('TR-6: Monthly (6mo) tab renders no "Invalid Date" text', async ({ page }) => {
    await seedSessionHistory({ project_key: 'tr6org/proj/main', duration_seconds: 300, cost_usd: 1.00 });
    await page.goto('/#time-report');
    await page.waitForSelector('#tr-tabs', { timeout: 10000 });

    const monthlyTab = page.locator('#tr-tabs .tab', { hasText: 'Monthly (6mo)' });
    await monthlyTab.click();
    await page.waitForTimeout(500);

    const bodyText = await page.locator('body').textContent();
    expect(bodyText).not.toContain('Invalid Date');
  });

  test('TR-7: Daily tab column headers show formatted dates, not "(unknown)" or "Invalid Date"', async ({ page }) => {
    await seedSessionHistory({ project_key: 'tr7org/proj/main', duration_seconds: 300, cost_usd: 1.00 });
    await page.goto('/#time-report');
    await page.waitForSelector('#tr-tabs', { timeout: 10000 });

    const dailyTab = page.locator('#tr-tabs .tab', { hasText: 'Daily (14d)' });
    await dailyTab.click();
    await page.waitForTimeout(500);

    // Column headers in the pivot table are <th> elements in the active panel
    const activePanel = page.locator('.tab-content.active');
    const headers = await activePanel.locator('thead th').allTextContents();
    const periodHeaders = headers.filter(h => h !== 'Project' && h !== 'Total' && h.trim() !== '');

    // Must have at least one period column (today's date)
    expect(periodHeaders.length).toBeGreaterThan(0);

    for (const h of periodHeaders) {
      expect(h).not.toContain('Invalid Date');
      expect(h).not.toBe('(unknown)');
      // Valid format e.g. "Mon, Jun 2" — contains a comma and a space
      expect(h).toMatch(/[A-Z][a-z]+/);
    }
  });

  test('TR-8: Monthly tab column headers show formatted month names, not "Invalid Date"', async ({ page }) => {
    await seedSessionHistory({ project_key: 'tr8org/proj/main', duration_seconds: 300, cost_usd: 1.00 });
    await page.goto('/#time-report');
    await page.waitForSelector('#tr-tabs', { timeout: 10000 });

    const monthlyTab = page.locator('#tr-tabs .tab', { hasText: 'Monthly (6mo)' });
    await monthlyTab.click();
    await page.waitForTimeout(500);

    const activePanel = page.locator('.tab-content.active');
    const headers = await activePanel.locator('thead th').allTextContents();
    const periodHeaders = headers.filter(h => h !== 'Project' && h !== 'Total' && h.trim() !== '');

    expect(periodHeaders.length).toBeGreaterThan(0);

    for (const h of periodHeaders) {
      expect(h).not.toContain('Invalid Date');
      expect(h).not.toBe('(unknown)');
      // Valid format e.g. "June 2026" — a month name followed by a year
      expect(h).toMatch(/^[A-Z][a-z]+ \d{4}$/);
    }
  });

});
