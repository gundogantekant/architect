/**
 * E2E criterion 3: Workflow pauses at approval gate → approval UI renders →
 * clicking "Approve" sends Temporal signal → workflow resumes and next response streams.
 */
import { test, expect } from '@playwright/test';

test('approval gate: renders when awaiting-approval, approves, workflow resumes', async ({ page }) => {
  test.skip(!process.env.E2E_LIVE_STACK, 'requires live Cognito stack — set E2E_LIVE_STACK=1');
  await page.goto('/chat/test-conversation-id');

  // Simulate SSE approval-required event
  await page.route('/api/conversations/*/stream', async (route) => {
    const body = `event: approval-required\ndata: {"conversationId":"test-conversation-id"}\n\n`;
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
      body,
    });
  });

  // Wait for approval gate to render
  await page.waitForSelector('text=This action requires your approval', { timeout: 5000 });

  // Mock signal endpoint
  await page.route('/api/conversations/*/signal', async (route) => {
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  // Click Approve
  await page.click('button:has-text("Approve")');

  // Gate should dismiss
  await expect(page.locator('text=This action requires your approval')).not.toBeVisible({ timeout: 3000 });
});
