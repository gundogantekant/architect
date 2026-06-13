/**
 * Access Blocklist Unblock UX E2E Tests (E5) — Fix 3 (client side)
 *
 * Guards the observable unblock flow on the #access page:
 *   - Successful unblock removes the row and keeps #block-error hidden.
 *   - A failed unblock (server 400 for a malformed IP) surfaces the error in
 *     #block-error and does NOT clear the blocklist.
 *
 * The blocklist is seeded through the real /api/access/block POST route against
 * the isolated test server (loopback is exempt; we use a non-loopback test IP).
 *
 * Cross-dependency: the forced-400 path depends on the DELETE route returning
 * 400 for malformed IP params. That guard lives in routes/access.mjs (isValidIp).
 *
 * AU-1: Unblock a seeded IP → row disappears, #block-error stays hidden
 * AU-2: Unblock a malformed IP → #block-error visible with message, no refresh
 */

import { test, expect } from './fixtures.mjs';
import { getBase, api } from './helpers.mjs';

const TEST_IP = '203.0.113.7';

async function blockIp(ip, reason = 'test-seed') {
  return api('access/block', { method: 'POST', body: JSON.stringify({ ip, reason }) });
}

async function gotoAccess(page) {
  await page.goto(`${getBase()}/#access`);
  await page.waitForSelector('#blocklist-table', { timeout: 15_000 });
}

// ============================================================
// AU-1: Successful unblock removes the row, no error shown
// ============================================================

test('AU-1: unblocking a seeded IP removes its row and keeps #block-error hidden', async ({ page }) => {
  test.setTimeout(30_000);
  await blockIp(TEST_IP);

  await gotoAccess(page);

  // The seeded IP row should render with an Unblock button.
  const row = page.locator('#blocklist-table tr', { hasText: TEST_IP });
  await expect(row).toBeVisible({ timeout: 10_000 });

  await row.getByRole('button', { name: 'Unblock' }).click();

  // Row disappears after refreshAll() — the table re-renders to "No IPs blocked."
  await expect(page.locator('#blocklist-table tr', { hasText: TEST_IP })).toHaveCount(0, { timeout: 10_000 });

  // No error surfaced.
  await expect(page.locator('#block-error')).toBeHidden();
});

// ============================================================
// AU-2: Failed unblock (malformed IP, server 400) surfaces error, no refresh
// ============================================================

test('AU-2: unblocking a malformed IP surfaces #block-error and leaves the blocklist intact', async ({ page }) => {
  test.setTimeout(30_000);
  // Seed a valid blocked IP so the table is non-empty and we can prove no refresh-away.
  await blockIp(TEST_IP);

  await gotoAccess(page);
  await expect(page.locator('#blocklist-table tr', { hasText: TEST_IP })).toBeVisible({ timeout: 10_000 });

  // Drive unblock with a malformed IP directly through the exposed window handler.
  // The DELETE route returns 400 "invalid IP" for malformed path params (Agent B / routes/access.mjs).
  await page.evaluate(() => window.unblockIp('not-an-ip', null));

  const err = page.locator('#block-error');
  await expect(err).toBeVisible({ timeout: 5000 });
  await expect(err).not.toHaveText('');

  // The valid blocked IP must still be present — failure must not refresh/clear the table.
  await expect(page.locator('#blocklist-table tr', { hasText: TEST_IP })).toBeVisible();
});
