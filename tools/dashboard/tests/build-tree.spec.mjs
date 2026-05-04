/**
 * buildTree() per-org render guard contract test (W-959).
 *
 * Plan: /Users/tekantgundogan/.claude/plans/curried-bubbling-hinton.md
 *
 * Asserts that a transient API failure on a single org does not abort the
 * whole tree render: orgs alphabetically before AND after the failing one
 * still render, the failing org gets a degraded placeholder tile with
 * role="alert" + visible inline error message, and console.error is invoked
 * with the contract identifier and structured payload.
 *
 * Written per domain/rules.md → Contract-First Planning Rules.
 */

import { test, expect } from './fixtures.mjs';

test.describe('buildTree() per-org render guard', () => {
  test('BT-1: failing org renders degraded tile; alphabetically-later orgs still render', async ({ page }) => {
    const consoleErrorArgs = [];
    page.on('console', async msg => {
      if (msg.type() !== 'error') return;
      try {
        const parts = await Promise.all(msg.args().map(a => a.jsonValue().catch(() => null)));
        consoleErrorArgs.push(parts);
      } catch { /* ignore */ }
    });

    // Intercept org-listing and per-org calls so we deterministically control
    // which org's API rejects. Everything else (backlog, preferences) falls
    // through to the isolated test server.
    await page.route('**/api/orgs', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['a-ok', 'b-broken', 'c-ok']) })
    );
    await page.route('**/api/org/b-broken/projects', route =>
      route.fulfill({ status: 500, contentType: 'text/plain', body: 'simulated SQLITE_IOERR' })
    );
    await page.route('**/api/org/a-ok/projects', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['p1']) })
    );
    await page.route('**/api/org/c-ok/projects', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['p1']) })
    );
    await page.route('**/api/org/a-ok', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'a-ok', path_root: '/tmp/a-ok' }) })
    );
    await page.route('**/api/org/c-ok', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ name: 'c-ok', path_root: '/tmp/c-ok' }) })
    );
    await page.route('**/api/project/a-ok/p1', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['main.json']) })
    );
    await page.route('**/api/project/c-ok/p1', route =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(['main.json']) })
    );

    await page.goto('/');
    await page.waitForFunction(
      () => document.querySelectorAll('#tree .org-group').length >= 3,
      null,
      { timeout: 15000 }
    );

    // Three org groups total
    expect(await page.locator('#tree .org-group').count()).toBe(3);

    // Exactly one degraded tile
    const degraded = page.locator('#tree .org-group.org-degraded');
    await expect(degraded).toHaveCount(1);

    // Degraded tile carries role="alert", references the failing org, and shows
    // the inline error-detail span (not just a hover tooltip)
    const degradedAlert = degraded.locator('.org-name[role="alert"]');
    await expect(degradedAlert).toBeVisible();
    await expect(degradedAlert).toContainText('b-broken');
    await expect(degradedAlert).toContainText('failed to load');
    await expect(degradedAlert.locator('.org-error-detail')).toBeVisible();

    // a-ok (alphabetically before the failure) still rendered fully
    const aOkGroup = page.locator('#tree .org-group').nth(0);
    await expect(aOkGroup).not.toHaveClass(/org-degraded/);
    await expect(aOkGroup.locator('.project-list')).toHaveCount(1);

    // c-ok (alphabetically AFTER the failure) still rendered fully — the regression case
    const cOkGroup = page.locator('#tree .org-group').nth(2);
    await expect(cOkGroup).not.toHaveClass(/org-degraded/);
    await expect(cOkGroup.locator('.project-list')).toHaveCount(1);

    // console.error called with the contract identifier and structured payload
    const matching = consoleErrorArgs.find(parts => parts[0] === '[buildTree] org render failed');
    expect(matching, 'expected console.error("[buildTree] org render failed", { org, err })').toBeTruthy();
    expect(matching[1]).toBeDefined();
    expect(matching[1].org).toBe('b-broken');
  });
});
