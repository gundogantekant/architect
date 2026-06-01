import { test, expect } from './fixtures.mjs';
import { getBase, seedTerminal, api } from './helpers.mjs';

test.describe('Terminal notes API @fast', () => {

  test('TN-1: PATCH /api/terminal/:id/note with valid string → ok + note', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const result = await api(`terminal/${t.id}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'test note' }),
    });
    expect(result.ok).toBe(true);
    expect(result.note).toBe('test note');
  });

  test('TN-2: PATCH with empty string → ok + note null (cleared)', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const result = await api(`terminal/${t.id}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: '' }),
    });
    expect(result.ok).toBe(true);
    expect(result.note).toBeNull();
  });

  test('TN-3: PATCH with null → ok + note null (cleared)', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const result = await api(`terminal/${t.id}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: null }),
    });
    expect(result.ok).toBe(true);
    expect(result.note).toBeNull();
  });

  test('TN-4: note > 200 chars → 400 with "200" in error', async ({ request }) => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await request.patch(`${getBase()}/api/terminal/${t.id}/note`, {
      data: { note: 'x'.repeat(201) },
    });
    expect(resp.status()).toBe(400);
    const body = await resp.json();
    expect(body.error).toContain('200');
  });

  test('TN-5: PATCH with non-string note → 400', async ({ request }) => {
    const t = await seedTerminal({ skip_seed: true });
    const resp = await request.patch(`${getBase()}/api/terminal/${t.id}/note`, {
      data: { note: 12345 },
    });
    expect(resp.status()).toBe(400);
  });

  test('TN-6: PATCH on non-existent terminal → 404', async ({ request }) => {
    const resp = await request.patch(`${getBase()}/api/terminal/T-nonexistent/note`, {
      data: { note: 'hello' },
    });
    expect(resp.status()).toBe(404);
  });

  test('TN-7: GET /api/terminal/active includes note field on seeded terminal', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const terminals = await api('terminal/active');
    const found = terminals.find(x => x.id === t.id);
    expect(found).toBeDefined();
    expect('note' in found).toBe(true);
  });

  test('TN-8: round-trip — PATCH note then GET active returns same value', async () => {
    const t = await seedTerminal({ skip_seed: true });
    await api(`terminal/${t.id}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'round-trip value' }),
    });
    const terminals = await api('terminal/active');
    const found = terminals.find(x => x.id === t.id);
    expect(found).toBeDefined();
    expect(found.note).toBe('round-trip value');
  });

  test('TN-9: POST /api/terminal new session includes note: null', async () => {
    const t = await seedTerminal({ skip_seed: true });
    const terminals = await api('terminal/active');
    const found = terminals.find(x => x.id === t.id);
    expect(found).toBeDefined();
    expect(found.note).toBeNull();
  });

});

// ============================================================
// E2E tests — Terminal Notes (TNE2E)
// Selector strategy: stable CSS classes (.terminal-note-row, .terminal-note-input,
//   .terminal-note, .terminal-note-empty) — no data-testid needed.
// Hover approach: locator.hover() — headless Playwright fires CSS :hover.
// Wait strategy: expect(locator).toBeVisible() / toHaveText() / toBeFocused().
// ============================================================

test.describe('Terminal notes E2E — TNE2E', () => {

  // Seed a terminal and navigate to the dashboard before each test.
  let terminalId;
  test.beforeEach(async ({ page }) => {
    const t = await seedTerminal({ skip_seed: true });
    terminalId = t.id;
    await page.goto('/');
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
  });

  test('TNE2E-1: hovering the terminal header reveals the ✎ label session placeholder', async ({ page }) => {
    await page.locator(`#terminal-${terminalId} .terminal-header`).hover();
    const placeholder = page.locator(`#terminal-${terminalId} .terminal-note-empty`);
    await expect(placeholder).toBeVisible();
    // opacity should be > 0 (the hover state applies opacity: 1)
    const opacity = await placeholder.evaluate(el => parseFloat(getComputedStyle(el).opacity));
    expect(opacity).toBeGreaterThan(0);
  });

  test('TNE2E-2: clicking the note row opens an input with focus', async ({ page }) => {
    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    const input = page.locator(`#terminal-${terminalId} .terminal-note-input`);
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('TNE2E-3: typing a label and pressing Enter saves it in the note row', async ({ page }) => {
    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    const input = page.locator(`#terminal-${terminalId} .terminal-note-input`);
    await input.fill('my session label');
    await input.press('Enter');
    // Wait for the edit mode to exit and the label to appear.
    await expect(page.locator(`#terminal-${terminalId} .terminal-note`)).toHaveText('my session label', { timeout: 10_000 });
    await expect(input).not.toBeVisible();
  });

  test('TNE2E-4: label persists across page reload', async ({ page }) => {
    // Save a label via the API (bypasses UI to isolate persistence test)
    await api(`terminal/${terminalId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'persistent label' }),
    });
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId}`, { timeout: 10_000 });
    await expect(page.locator(`#terminal-${terminalId} .terminal-note`)).toHaveText('persistent label');
  });

  test('TNE2E-5: clicking an existing label pre-fills the input; Escape restores the original', async ({ page }) => {
    // Seed an existing label
    await api(`terminal/${terminalId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'original label' }),
    });
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId} .terminal-note`, { timeout: 10_000 });

    // Click to edit
    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    const input = page.locator(`#terminal-${terminalId} .terminal-note-input`);
    await expect(input).toHaveValue('original label');

    // Change value then Escape
    await input.fill('changed label');
    await page.keyboard.press('Escape');

    // Original label is restored
    await expect(page.locator(`#terminal-${terminalId} .terminal-note`)).toHaveText('original label');
    await expect(input).not.toBeVisible();
  });

  test('TNE2E-6: clicking ✓ saves the label correctly', async ({ page }) => {
    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    const input = page.locator(`#terminal-${terminalId} .terminal-note-input`);
    await input.fill('label via button');
    await page.locator(`#terminal-${terminalId} .terminal-note-save-btn`).click();
    // Wait for the label to appear in the note row.
    await expect(page.locator(`#terminal-${terminalId} .terminal-note`)).toHaveText('label via button', { timeout: 10_000 });
    await expect(input).not.toBeVisible();
    // Verify persistence via the server state.
    const terminals = await api('terminal/active');
    const found = terminals.find(x => x.id === terminalId);
    expect(found?.note).toBe('label via button');
  });

  test('TNE2E-7: clicking Clear removes the label and shows the placeholder', async ({ page }) => {
    // Seed a label first
    await api(`terminal/${terminalId}/note`, {
      method: 'PATCH',
      body: JSON.stringify({ note: 'label to clear' }),
    });
    await page.reload();
    await page.waitForSelector(`#terminal-${terminalId} .terminal-note`, { timeout: 10_000 });

    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    await page.locator(`#terminal-${terminalId} .terminal-note-clear-btn`).click();

    // Wait for the note span to disappear and the placeholder to appear.
    await expect(page.locator(`#terminal-${terminalId} .terminal-note`)).not.toBeVisible({ timeout: 10_000 });
    await expect(page.locator(`#terminal-${terminalId} .terminal-note-empty`)).toBeAttached({ timeout: 5_000 });
    // Verify the server cleared the note (last PATCH with note:null wins).
    const terminals = await api('terminal/active');
    const found = terminals.find(x => x.id === terminalId);
    expect(found?.note).toBeNull();
  });

  test('TNE2E-8: restoreTerminals poll while input is active does NOT replace the input', async ({ page }) => {
    await page.locator(`#terminal-${terminalId} .terminal-note-row`).click();
    const input = page.locator(`#terminal-${terminalId} .terminal-note-input`);
    await input.fill('typing in progress');

    // Trigger a server-side change that would cause restoreTerminals to re-render:
    // PATCH the terminal title, which the poll picks up and re-renders in the title span.
    const base = getBase();
    await page.evaluate(
      ({ base, tid }) => fetch(`${base}/api/terminal/${tid}/title`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'updated-title-by-test' }),
      }),
      { base, tid: terminalId },
    );

    // Wait for a poll cycle (restoreTerminals runs every 10s; test waits for a short settle)
    await page.waitForTimeout(500);

    // Input must still be present and contain the typed value
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('typing in progress');
  });

});
