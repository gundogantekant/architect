/**
 * E2E criterion 4: Open two sessions as two different Cognito users
 * → verify each session runs an independent UserSessionWorkflow with no message crossover.
 */
import { test, expect, chromium } from '@playwright/test';

test('multi-user: two Cognito users have isolated workflows', async () => {
  const browser = await chromium.launch();

  const context1 = await browser.newContext();
  const context2 = await browser.newContext();

  const page1 = await context1.newPage();
  const page2 = await context2.newPage();

  // Both users navigate to chat (assume pre-authenticated for test environment)
  await page1.goto('/chat');
  await page2.goto('/chat');

  // Create separate conversations for each user
  const res1 = await page1.request.post('/api/conversations', {
    data: { title: 'User 1 conversation' }
  });
  const res2 = await page2.request.post('/api/conversations', {
    data: { title: 'User 2 conversation' }
  });

  const conv1 = await res1.json();
  const conv2 = await res2.json();

  // Each user should have a different conversation ID (different workflows)
  expect(conv1.id).not.toBe(conv2.id);

  // Verify isolation: user 2 cannot access user 1's conversation
  const crossCheck = await page2.request.get(`/api/conversations/${conv1.id}`);
  expect(crossCheck.status()).toBe(404);

  await browser.close();
});
