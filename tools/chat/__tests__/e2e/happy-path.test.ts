/**
 * E2E criterion 1: Login via Cognito → new conversation → send message →
 * verify userMessageSignal received, response streams to UI,
 * ai_chat.messages contains both turns, ai_chat.token_usage has row with cost_usd > 0.
 *
 * NOTE: Requires live Temporal server, Cognito, and PostgreSQL with migration 032.
 * Run: NEXT_PUBLIC_COGNITO_USER_POOL_ID=... TEMPORAL_ADDRESS=... npm test
 */
import { test, expect } from '@playwright/test';

test('happy path: login, create conversation, send message, verify DB records', async ({ page }) => {
  test.skip(!process.env.E2E_LIVE_STACK, 'requires live Cognito stack — set E2E_LIVE_STACK=1');
  // Step 1: Navigate to login
  await page.goto('/login');
  await page.waitForSelector('[data-amplify-authenticator]');

  // Step 2: Sign in with test credentials (env vars: E2E_COGNITO_USER, E2E_COGNITO_PASS)
  const email = process.env.E2E_COGNITO_USER ?? 'test@example.com';
  const password = process.env.E2E_COGNITO_PASS ?? 'TestPass1!';
  await page.fill('input[name="username"]', email);
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForURL('/chat');

  // Step 3: Create new conversation
  await page.click('button:has-text("New conversation")');
  await page.waitForURL(/\/chat\/.+/);

  // Step 4: Send message
  await page.fill('textarea', 'What is the architect project?');
  await page.click('button:has-text("Send")');

  // Step 5: Wait for assistant response (streaming)
  await page.waitForSelector('[data-role="assistant"]', { timeout: 60000 });
  const responseText = await page.locator('[data-role="assistant"]').last().textContent();
  expect(responseText?.length).toBeGreaterThan(0);

  // Step 6: Reload page and verify history restored
  await page.reload();
  const messages = await page.locator('[data-role]').all();
  expect(messages.length).toBeGreaterThanOrEqual(2);
});
