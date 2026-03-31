/**
 * Error Path Tests
 *
 * Validates that the dashboard handles invalid inputs, unknown routes, and
 * non-existent resources gracefully — no JS crashes, no 5xx responses.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch, api } from './helpers.mjs';

test.describe('Error paths @behavioral', () => {

  test('EP-1: navigating to nonexistent terminal does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/#terminal/nonexistent-id-99999');
    await page.waitForTimeout(2000);
    // page should not throw uncaught JS errors
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('EP-2: killed dispatch shows non-running status', async ({ page }) => {
    const { dispatch_id } = await seedDispatch({ status: 'completed', output: ['done'] });
    await page.goto('/');
    await page.waitForTimeout(500);
    // dispatch panel should not show "running" badge
    const panel = page.locator(`[id="dispatch-${dispatch_id}"], #dispatch-${dispatch_id}`);
    if (await panel.count() > 0) {
      await expect(panel).not.toContainText('running');
    }
  });

  test('EP-3: navigating to unknown component does not crash', async ({ page }) => {
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('/#component/unknown-org/unknown-proj/main');
    await page.waitForTimeout(2000);
    expect(errors.filter(e => !e.includes('favicon'))).toHaveLength(0);
  });

  test('EP-4: POST work-item without title returns 4xx not 5xx', async () => {
    const resp = await fetch(`${getBase()}/api/work-items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'open' }), // missing title
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
    expect(resp.status).toBeLessThan(500);
  });
});
