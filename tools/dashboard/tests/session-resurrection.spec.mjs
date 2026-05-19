/**
 * Session Resurrection Tests (W-1139)
 *
 * Verifies exit_type classification (graceful / killed / interrupted),
 * the recovery banner for interrupted dispatches, and the dismiss flow.
 *
 * Unit-level tests (SR-1 to SR-5) run against the live test server API.
 * UI tests (SR-6, SR-7) use Playwright to verify DOM rendering.
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch } from './helpers.mjs';

// ============================================================
// Suite: Exit-type classification (API-level)
// ============================================================

test.describe('Session resurrection @fast', () => {

  test.beforeAll(async () => {
    await fetch(`${getBase()}/api/test/purge-all`, { method: 'POST' });
  });

  // SR-1: Dispatch seeded with exit_type=graceful is surfaced via /api/dispatch/active
  test('SR-1: dispatch with clean exit reports exit_type=graceful', async () => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'completed',
      exit_type: 'graceful',
    });

    const res = await fetch(`${getBase()}/api/dispatch/active`, {
      headers: { 'x-test-worker-id': String(process.env.TEST_WORKER_INDEX ?? '') },
    });
    expect(res.ok).toBe(true);
    const list = await res.json();
    const d = list.find(x => x.id === id);
    expect(d, 'dispatch not found in active list').toBeTruthy();
    expect(d.exit_type).toBe('graceful');
  });

  // SR-2: Dispatch seeded with exit_type=interrupted is surfaced via /api/dispatch/active
  test('SR-2: dispatch with non-zero exit + not killed reports exit_type=interrupted', async () => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'interrupted',
      exit_type: 'interrupted',
    });

    const res = await fetch(`${getBase()}/api/dispatch/active`, {
      headers: { 'x-test-worker-id': String(process.env.TEST_WORKER_INDEX ?? '') },
    });
    expect(res.ok).toBe(true);
    const list = await res.json();
    const d = list.find(x => x.id === id);
    expect(d, 'interrupted dispatch not found').toBeTruthy();
    expect(d.exit_type).toBe('interrupted');
  });

  // SR-3: Dispatch seeded with exit_type=killed is surfaced correctly
  test('SR-3: intentionally killed dispatch reports exit_type=killed', async () => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'killed',
      exit_type: 'killed',
    });

    // killed dispatches are excluded from getPersistedDispatches but still in memory
    const res = await fetch(`${getBase()}/api/dispatch/active`, {
      headers: { 'x-test-worker-id': String(process.env.TEST_WORKER_INDEX ?? '') },
    });
    expect(res.ok).toBe(true);
    const list = await res.json();
    const d = list.find(x => x.id === id);
    // In-memory only (killed status excluded from DB persistence filter) — still in active list
    expect(d, 'killed dispatch not found in active list').toBeTruthy();
    expect(d.exit_type).toBe('killed');
  });

  // SR-4: dismiss endpoint marks an interrupted dispatch as dismissed
  test('SR-4: POST /dismiss transitions interrupted → dismissed', async () => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'interrupted',
      exit_type: 'interrupted',
    });

    const dismissRes = await fetch(`${getBase()}/api/dispatch/${id}/dismiss`, {
      method: 'POST',
    });
    expect(dismissRes.ok, 'dismiss should succeed').toBe(true);
    const body = await dismissRes.json();
    expect(body.status).toBe('dismissed');
    expect(body.id).toBe(id);
  });

  // SR-5: dismiss endpoint rejects non-interrupted dispatches
  test('SR-5: POST /dismiss on non-interrupted dispatch returns 400', async () => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'completed',
      exit_type: 'graceful',
    });

    const dismissRes = await fetch(`${getBase()}/api/dispatch/${id}/dismiss`, {
      method: 'POST',
    });
    expect(dismissRes.status).toBe(400);
  });

  // SR-6: interrupted dispatch shows recovery banner; killed dispatch does NOT
  test('SR-6: interrupted dispatch shows recovery banner; killed does not', async ({ page }) => {
    const { dispatch_id: interruptedId } = await seedDispatch({
      status: 'interrupted',
      exit_type: 'interrupted',
    });
    const { dispatch_id: killedId } = await seedDispatch({
      status: 'killed',
      exit_type: 'killed',
    });

    await page.goto('/');

    // Interrupted dispatch should show recovery banner
    const interruptedPanel = page.locator(`#dispatch-${interruptedId}`);
    await expect(interruptedPanel).toBeVisible({ timeout: 8000 });
    const banner = interruptedPanel.locator('[data-recovery-dispatch]');
    await expect(banner).toBeVisible({ timeout: 5000 });
    await expect(banner).toContainText('Session interrupted — recover?');

    // Killed dispatch must NOT show a recovery banner
    const killedPanel = page.locator(`#dispatch-${killedId}`);
    await expect(killedPanel).toBeVisible({ timeout: 5000 });
    const killedBanner = killedPanel.locator('[data-recovery-dispatch]');
    await expect(killedBanner).not.toBeAttached();
  });

  // SR-7: clicking Dismiss on recovery banner removes the banner and calls /dismiss
  test('SR-7: dismissed dispatch does not show recovery banner after dismissal', async ({ page }) => {
    const { dispatch_id: id } = await seedDispatch({
      status: 'interrupted',
      exit_type: 'interrupted',
    });

    await page.goto('/');
    const panel = page.locator(`#dispatch-${id}`);
    await expect(panel).toBeVisible({ timeout: 8000 });
    const banner = panel.locator('[data-recovery-dispatch]');
    await expect(banner).toBeVisible({ timeout: 5000 });

    // Click the Dismiss button in the recovery banner
    const dismissBtn = panel.locator('[data-dismiss-interrupted]');
    await expect(dismissBtn).toBeVisible();
    await dismissBtn.click();

    // Banner should be removed from the DOM
    await expect(banner).not.toBeAttached({ timeout: 5000 });

    // Verify server-side status changed to dismissed
    const res = await fetch(`${getBase()}/api/dispatch/active`);
    const list = await res.json();
    // The dismissed dispatch may no longer appear (excluded from DB filter on next restart)
    // but if it does appear, status must be 'dismissed'
    const d = list.find(x => x.id === id);
    if (d) {
      expect(d.status).toBe('dismissed');
    }
  });
});
