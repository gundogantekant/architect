/**
 * E2E criterion 5: Reload the page mid-conversation → verify conversation history
 * restored from ai_chat.messages and workflow status indicator reflects Temporal state.
 */
import { test, expect } from '@playwright/test';

test('page reload: history restored and workflow status correct', async ({ page }) => {
  await page.goto('/chat/test-conversation-id');

  // Mock conversations endpoint to return messages
  await page.route('/api/conversations/test-conversation-id', async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({
        id: 'test-conversation-id',
        messages: [
          { id: 'msg-1', role: 'user', content: 'Hello', createdAt: new Date().toISOString() },
          { id: 'msg-2', role: 'assistant', content: 'Hello! How can I help?', createdAt: new Date().toISOString() },
        ],
      }),
    });
  });

  // Mock workflow status endpoint
  await page.route('/api/conversations/test-conversation-id/status', async (route) => {
    await route.fulfill({
      status: 200,
      body: JSON.stringify({ sessionId: 'test-conversation-id', sessionState: 'idle', messageCount: 2 }),
    });
  });

  // Reload page
  await page.reload();

  // Verify messages restored
  await page.waitForSelector('[data-role="user"]', { timeout: 5000 });
  const userMessages = await page.locator('[data-role="user"]').all();
  expect(userMessages.length).toBeGreaterThanOrEqual(1);

  const assistantMessages = await page.locator('[data-role="assistant"]').all();
  expect(assistantMessages.length).toBeGreaterThanOrEqual(1);

  // Verify workflow status shows Idle
  await page.waitForSelector('text=Idle', { timeout: 3000 });
});
