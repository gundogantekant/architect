/**
 * Contract tests for GEN-session-end-fix: 409 body, sidebar kill button,
 * terminal Kill panel/dot classes, and kill failure toast.
 *
 * CT-1: 409 includes blocking_terminal_id and conflict_type
 * CT-2: Kill resolves the 409 — subsequent POST does not 409
 * CT-3: Terminal Kill handler updates panel class to status-killed (browser)
 * CT-4: Terminal Kill handler dot gets 'killed' class (browser)
 * CT-5: Kill failure shows toast-error (browser)
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedTerminal, purgeAll } from './helpers.mjs';

test.beforeAll(async () => { await purgeAll(); });
test.afterEach(async () => { await purgeAll(); });

// ---------------------------------------------------------------------------
// CT-1: 409 body must include blocking_terminal_id and conflict_type
// ---------------------------------------------------------------------------

test('CT-1: 409 includes blocking_terminal_id and conflict_type @fast', async () => {
  const base = getBase();
  const seeded = await seedTerminal({ project_key: 'ticari/test-session-end/main', status: 'running' });

  const res = await fetch(`${base}/api/projects/ticari/test-session-end/main/refine-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  expect(res.status).toBe(409);
  const body = await res.json();
  expect(body.blocking_terminal_id).toBe(seeded.id);
  expect(body.conflict_type).toBe('terminal');
});

// ---------------------------------------------------------------------------
// CT-2: Kill resolves the 409 — subsequent POST must not 409
// ---------------------------------------------------------------------------

test('CT-2: kill resolves 409 — subsequent POST is not 409 @fast', async () => {
  const base = getBase();
  const seeded = await seedTerminal({ project_key: 'ticari/test-session-end/main', status: 'running' });

  const first = await fetch(`${base}/api/projects/ticari/test-session-end/main/refine-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(first.status).toBe(409);
  const firstBody = await first.json();
  expect(firstBody.blocking_terminal_id).toBe(seeded.id);

  const kill = await fetch(`${base}/api/terminal/${firstBody.blocking_terminal_id}`, { method: 'DELETE' });
  expect(kill.status).toBe(200);

  const second = await fetch(`${base}/api/projects/ticari/test-session-end/main/refine-terminal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  // 409 must be gone — will likely 404 because no real project exists, which is fine
  expect(second.status).not.toBe(409);
});

// ---------------------------------------------------------------------------
// CT-3: Terminal Kill handler updates panel class to status-killed (browser)
// ---------------------------------------------------------------------------

test('CT-3: terminal Kill handler updates panel class to status-killed', async ({ page }) => {
  const base = getBase();
  const { id } = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${id}`, { timeout: 8000 });

  await page.locator(`[data-kill-terminal="${id}"]`).click();

  await page.waitForFunction(
    (termId) => document.getElementById(`terminal-${termId}`)?.classList.contains('status-killed'),
    id,
    { timeout: 6000 },
  );

  const hasRunning = await page.evaluate(
    (termId) => document.getElementById(`terminal-${termId}`)?.classList.contains('status-running'),
    id,
  );
  expect(hasRunning).toBe(false);
});

// ---------------------------------------------------------------------------
// CT-4: Terminal Kill handler dot gets 'killed' and 'failed' classes (browser)
// ---------------------------------------------------------------------------

test('CT-4: terminal Kill handler dot gets killed and failed classes', async ({ page }) => {
  const base = getBase();
  const { id } = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${id}`, { timeout: 8000 });

  await page.locator(`[data-kill-terminal="${id}"]`).click();

  await page.waitForFunction(
    (termId) => {
      const dot = document.getElementById(`terminal-${termId}`)?.querySelector('.status-dot');
      return dot?.classList.contains('killed');
    },
    id,
    { timeout: 6000 },
  );

  const hasFailed = await page.evaluate(
    (termId) => {
      const dot = document.getElementById(`terminal-${termId}`)?.querySelector('.status-dot');
      return dot?.classList.contains('failed');
    },
    id,
  );
  expect(hasFailed).toBe(true);
});

// ---------------------------------------------------------------------------
// CT-5: Kill failure shows toast-error (browser)
// ---------------------------------------------------------------------------

test('CT-5: kill failure shows toast-error', async ({ page }) => {
  const { id } = await seedTerminal({ status: 'running' });

  await page.goto('/');
  await page.waitForSelector(`#terminal-${id}`, { timeout: 8000 });

  // Intercept the Kill DELETE before it reaches the server so the panel
  // stays in the DOM (no SSE broadcast) but the kill appears to fail.
  await page.route(`**/api/terminal/${id}`, (route) => {
    if (route.request().method() === 'DELETE') {
      route.fulfill({ status: 500, body: JSON.stringify({ error: 'simulated failure' }), contentType: 'application/json' });
    } else {
      route.continue();
    }
  });

  await page.locator(`[data-kill-terminal="${id}"]`).click();

  await page.waitForSelector('.toast-error', { timeout: 6000 });
});
