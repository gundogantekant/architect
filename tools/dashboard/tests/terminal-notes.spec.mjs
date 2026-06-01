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

// E2E placeholders — implement once the frontend is shipped
test.fixme('TNE2E-1: hovering the terminal header shows the ✎ add-note icon', async ({ page }) => {});
test.fixme('TNE2E-2: clicking the add-note icon opens an input with focus', async ({ page }) => {});
test.fixme('TNE2E-3: typing a note and pressing Enter saves it in the micro-row', async ({ page }) => {});
test.fixme('TNE2E-4: note persists across page reload', async ({ page }) => {});
test.fixme('TNE2E-5: clicking an existing note pre-fills the input; Escape restores the original', async ({ page }) => {});
test.fixme('TNE2E-6: clicking ✓ saves without a spurious blur save', async ({ page }) => {});
test.fixme('TNE2E-7: clicking Clear removes the note', async ({ page }) => {});
test.fixme('TNE2E-8: SSE event while editing does NOT overwrite the active input', async ({ page }) => {});
