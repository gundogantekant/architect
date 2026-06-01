/**
 * Contract tests for doc/plan/artifact content integrity (W-1264).
 *
 * Verifies that:
 * 1. Multi-paragraph content round-trips through PUT→GET without corruption.
 * 2. One-char-per-line content is rejected with 422 on all three write paths.
 * 3. Invalid JSON body is rejected with 400 on all three write paths.
 *
 * Headless — no browser required. Prerequisite: dashboard server running.
 */

import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem } from './helpers.mjs';
import { getBase } from './helpers.mjs';

const CORRUPTED = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\nu\nv\nw\nx\ny\nz';
const NORMAL = [
  '# Phase A Documentation',
  '',
  'This is paragraph one with several words.',
  '',
  'This is paragraph two with several more words.',
  '',
  'And a final paragraph for good measure.',
].join('\n');

async function rawPut(path, body) {
  return fetch(`${getBase()}/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

test.describe('Doc content integrity guard @contracts', () => {
  test('DCI-1: PUT /api/work-items/:id/doc stores and retrieves multi-paragraph content intact', async () => {
    const item = await seedWorkItem({ title: 'DCI-1 doc round-trip' });
    await api(`work-items/${item.id}/doc`, {
      method: 'PUT',
      body: JSON.stringify({ content: NORMAL }),
    });
    const result = await fetch(`${getBase()}/api/work-items/${item.id}/doc`).then(r => r.text());
    expect(result).toBe(NORMAL);
    // No single-alpha-char-per-line corruption
    const lines = result.split('\n').filter(l => l.trim().length > 0);
    const corrupted = lines.filter(l => /^[a-zA-Z]$/.test(l.trim()));
    expect(corrupted.length).toBe(0);
  });

  test('DCI-2: PUT /api/work-items/:id/doc rejects one-char-per-line content with 422', async () => {
    const item = await seedWorkItem({ title: 'DCI-2 corrupted doc' });
    const res = await rawPut(
      `api/work-items/${item.id}/doc`,
      JSON.stringify({ content: CORRUPTED }),
    );
    expect(res.status).toBe(422);
  });

  test('DCI-3: PUT /api/work-items/:id/plan rejects one-char-per-line content with 422', async () => {
    const item = await seedWorkItem({ title: 'DCI-3 corrupted plan' });
    const res = await rawPut(
      `api/work-items/${item.id}/plan`,
      JSON.stringify({ content: CORRUPTED }),
    );
    expect(res.status).toBe(422);
  });

  test('DCI-4: PUT /api/work-items/:id/artifacts/:file rejects one-char-per-line content with 422', async () => {
    const item = await seedWorkItem({ title: 'DCI-4 corrupted artifact' });
    const res = await rawPut(
      `api/work-items/${item.id}/artifacts/notes.md`,
      JSON.stringify({ content: CORRUPTED }),
    );
    expect(res.status).toBe(422);
  });

  test('DCI-5: PUT /api/work-items/:id/doc rejects invalid JSON body with 400', async () => {
    const item = await seedWorkItem({ title: 'DCI-5 bad json' });
    const res = await rawPut(
      `api/work-items/${item.id}/doc`,
      'not valid json {{{',
    );
    expect(res.status).toBe(400);
  });

  test('DCI-6: PUT /api/work-items/:id/plan stores and retrieves multi-paragraph content intact', async () => {
    const item = await seedWorkItem({ title: 'DCI-6 plan round-trip' });
    await api(`work-items/${item.id}/plan`, {
      method: 'PUT',
      body: JSON.stringify({ content: NORMAL }),
    });
    const result = await fetch(`${getBase()}/api/work-items/${item.id}/plan`).then(r => r.text());
    expect(result).toBe(NORMAL);
  });

  test('DCI-7: short content with high single-char ratio passes (< 20 lines exemption)', async () => {
    // A code fence with single-char content lines — should NOT be rejected
    const fence = '```\na\nb\nc\nd\ne\nf\n```';
    const item = await seedWorkItem({ title: 'DCI-7 fence exemption' });
    const res = await rawPut(
      `api/work-items/${item.id}/doc`,
      JSON.stringify({ content: fence }),
    );
    expect(res.status).toBe(200);
  });
});
