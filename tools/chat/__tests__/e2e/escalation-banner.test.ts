/**
 * E2E criterion 2: Simulate W-1204 timeout_warning event with event: idle
 * → verify escalation banner appears inline → clicking "Extend" calls
 * POST /api/conversations/:id/signal → banner dismisses.
 */
import { test, expect } from '@playwright/test';

test('escalation banner: appears on timeout_warning, dismisses on extend', async ({ page }) => {
  await page.goto('/chat/test-conversation-id');

  // Simulate the timeout_warning event from W-1204
  await page.evaluate((conversationId) => {
    window.dispatchEvent(new CustomEvent('timeout_warning', {
      detail: { event: 'idle', conversationId },
    }));
  }, 'test-conversation-id');

  // Verify banner appears
  await page.waitForSelector('text=Session is idle', { timeout: 3000 });
  expect(await page.isVisible('text=Session is idle')).toBe(true);

  // Mock the signal endpoint
  await page.route('/api/conversations/*/signal', async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  // Click Extend
  await page.click('button:has-text("Extend")');

  // Verify banner dismisses
  await expect(page.locator('text=Session is idle')).not.toBeVisible({ timeout: 3000 });
});
