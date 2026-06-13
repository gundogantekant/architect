/**
 * Clipboard Fallback E2E Tests (E1) — Fix 1
 *
 * Guards the copyToClipboard() helper that adds an execCommand('copy') fallback
 * for non-secure contexts (plain-HTTP LAN IPs) where navigator.clipboard is
 * undefined. The three copy surfaces are:
 *   - prompt-preview copy (static preview, #prompt-preview-copied)
 *   - dyn-preview copy ("View Prompt" on dispatch panels, #dyn-preview-copied)
 *   - session-id copy (.session-id-copy tag on dispatch panels)
 *
 * Each test forces the non-secure path BEFORE app code runs via addInitScript:
 *   navigator.clipboard = undefined, window.isSecureContext = false,
 *   and document.execCommand stubbed to record calls and return a configurable value.
 *
 * Real clipboard read-back is NOT asserted (flaky/headless). We assert that the
 * execCommand('copy') fallback fired and the correct affordance is shown.
 *
 * CC-1: prompt-preview copy → fallback fires, "Copied!" shows
 * CC-2: dyn-preview ("View Prompt") copy → fallback fires, "Copied!" shows
 * CC-3: session-id copy → fallback fires, "Copied!" shows
 * CC-4: execCommand returns false → residual "Copy failed" affordance, no uncaught error
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedDispatch } from './helpers.mjs';

const SESSION_ID = 'sess-clip-0001';

/**
 * Force the non-secure clipboard path before any app code runs, and stub
 * document.execCommand to record calls. execCommandResult controls the return.
 */
async function forceNonSecureClipboard(page, execCommandResult = true) {
  await page.addInitScript((result) => {
    // navigator.clipboard is read-only in some engines; redefine it as undefined.
    try {
      Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    } catch {}
    Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true });
    window.__execCommandCalls = [];
    document.execCommand = (cmd) => {
      window.__execCommandCalls.push(cmd);
      return result;
    };
  }, execCommandResult);
}

async function getCopyCalls(page) {
  return page.evaluate(() => (window.__execCommandCalls || []).filter((c) => c === 'copy'));
}

// ============================================================
// CC-1: prompt-preview copy site (static openPromptPreview)
// ============================================================

test('CC-1: prompt-preview copy uses execCommand fallback and shows Copied!', async ({ page }) => {
  test.setTimeout(30_000);
  await forceNonSecureClipboard(page, true);

  // Stub the preview endpoint so the static preview renders quickly.
  await page.route(/\/api\/prompts\/preview$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rendered: 'PROMPT BODY FOR CLIPBOARD', placeholders: [], truncated: false }),
    });
  });

  await page.goto(`${getBase()}/#settings`);
  // openPromptPreview is exposed on window in test mode (fixture sets the flag).
  await page.waitForFunction(() => typeof window.openPromptPreview === 'function', { timeout: 15_000 });
  await page.evaluate(() => window.openPromptPreview('refinement', {}, document.body));

  await expect(page.locator('#prompt-preview-copy')).toBeVisible({ timeout: 5000 });
  // Wait for renderedText to be populated.
  await expect(page.locator('#prompt-preview-content')).toContainText('PROMPT BODY', { timeout: 5000 });

  await page.click('#prompt-preview-copy');

  await expect(page.locator('#prompt-preview-copied')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#prompt-preview-copied')).toHaveText('Copied!');
  expect(await getCopyCalls(page)).toContain('copy');
});

// ============================================================
// CC-2: dyn-preview ("View Prompt") copy site
// ============================================================

test('CC-2: View Prompt (dyn-preview) copy uses execCommand fallback and shows Copied!', async ({ page }) => {
  test.setTimeout(30_000);
  await forceNonSecureClipboard(page, true);

  const { dispatch_id: id } = await seedDispatch({
    status: 'completed',
    claude_session_id: SESSION_ID,
    output: ['hello\n'],
  });

  // View Prompt fetches /api/dispatch/:id/prompt — stub it with a recorded prompt.
  await page.route(new RegExp(`/api/dispatch/${id}/prompt$`), (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ prompt_text: 'DISPATCH PROMPT TEXT' }),
    });
  });

  await page.goto(`${getBase()}/#agents`);
  await page.waitForSelector(`[data-view-prompt-dispatch="${id}"]`, { timeout: 20_000 });
  await page.click(`[data-view-prompt-dispatch="${id}"]`);

  await expect(page.locator('#dyn-preview-content')).toContainText('DISPATCH PROMPT TEXT', { timeout: 10_000 });
  await page.click('#dyn-preview-copy');

  await expect(page.locator('#dyn-preview-copied')).toBeVisible({ timeout: 3000 });
  await expect(page.locator('#dyn-preview-copied')).toHaveText('Copied!');
  expect(await getCopyCalls(page)).toContain('copy');
});

// ============================================================
// CC-3: session-id copy tag
// ============================================================

test('CC-3: session-id copy uses execCommand fallback and shows Copied!', async ({ page }) => {
  test.setTimeout(30_000);
  await forceNonSecureClipboard(page, true);

  const { dispatch_id: id } = await seedDispatch({
    status: 'completed',
    claude_session_id: SESSION_ID,
    output: ['hello\n'],
  });

  await page.goto(`${getBase()}/#agents`);
  const tag = page.locator(`#dispatch-${id} .session-id-copy`).first();
  await tag.waitFor({ state: 'visible', timeout: 20_000 });
  await expect(tag).toHaveText(SESSION_ID);

  await tag.click();

  await expect(tag).toHaveText('Copied!', { timeout: 3000 });
  expect(await getCopyCalls(page)).toContain('copy');
});

// ============================================================
// CC-4: execCommand returns false → residual "Copy failed" affordance
// ============================================================

test('CC-4: failed execCommand shows residual "Copy failed" affordance with no uncaught error', async ({ page }) => {
  test.setTimeout(30_000);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e));

  // execCommand('copy') returns false this time.
  await forceNonSecureClipboard(page, false);

  await page.route(/\/api\/prompts\/preview$/, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ rendered: 'PROMPT BODY FOR CLIPBOARD', placeholders: [], truncated: false }),
    });
  });

  await page.goto(`${getBase()}/#settings`);
  await page.waitForFunction(() => typeof window.openPromptPreview === 'function', { timeout: 15_000 });
  await page.evaluate(() => window.openPromptPreview('refinement', {}, document.body));

  await expect(page.locator('#prompt-preview-content')).toContainText('PROMPT BODY', { timeout: 5000 });
  await page.click('#prompt-preview-copy');

  const indicator = page.locator('#prompt-preview-copied');
  await expect(indicator).toBeVisible({ timeout: 3000 });
  await expect(indicator).toContainText('Copy failed');
  expect(await getCopyCalls(page)).toContain('copy');
  expect(pageErrors).toHaveLength(0);
});
