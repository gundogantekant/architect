/**
 * Work item flag column CRUD contract tests (FL-2, FL-3, FL-5).
 *
 * Validates that the new W-951 flag columns (input_needed, released_*)
 * are correctly read and written through the API and are present in GET responses.
 *
 * FL-1 (draft default) and FL-4 (released metadata on done) are covered by
 * state-transitions.spec SM-7 and SM-8 respectively. These tests add structural
 * assertions: exact field names, types, and null states on GET responses.
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, api, getBase } from './helpers.mjs';

test.describe('Work item flag column contracts @fast', () => {

  test('FL-2: SET input_needed stores all metadata fields', async () => {
    const item = await seedWorkItem({ title: 'FL-2 set input-needed' });

    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'user@example.com', reason: 'Need clarification' }),
    });
    expect(resp.ok).toBe(true);

    const full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(true);
    expect(full.input_needed_from).toBe('user@example.com');
    expect(full.input_needed_reason).toBe('Need clarification');
    expect(typeof full.input_needed_at).toBe('string');
  });

  test('FL-3: CLEAR input_needed nulls all metadata fields', async () => {
    const item = await seedWorkItem({ title: 'FL-3 clear input-needed' });

    await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'user@example.com', reason: 'Pending' }),
    });

    const resp = await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    expect(resp.ok).toBe(true);

    const full = await api(`work-items/${item.id}`);
    expect(full.input_needed).toBe(false);
    expect(full.input_needed_from).toBeFalsy();
    expect(full.input_needed_reason).toBeFalsy();
    expect(full.input_needed_at).toBeFalsy();
  });

  test('FL-5: GET /api/work-items/:id includes all W-951 flag columns', async () => {
    const item = await seedWorkItem({ title: 'FL-5 all columns present' });
    const full = await api(`work-items/${item.id}`);

    // input_needed family
    expect('input_needed' in full).toBe(true);
    expect('input_needed_from' in full).toBe(true);
    expect('input_needed_reason' in full).toBe(true);
    expect('input_needed_at' in full).toBe(true);

    // released family
    expect('released_at' in full).toBe(true);
    expect('released_version' in full).toBe(true);

    // approval nested object
    expect(full.approval).toBeDefined();
    expect('active' in full.approval).toBe(true);
    expect('mode' in full.approval).toBe(true);
    expect('requested_at' in full.approval).toBe(true);
    expect('resolved_at' in full.approval).toBe(true);
    expect(Array.isArray(full.approval.approvers)).toBe(true);

    // defaults on fresh item
    expect(full.input_needed).toBe(false);
    expect(full.input_needed_from).toBeFalsy();
    expect(full.released_at).toBeFalsy();
    expect(full.released_version).toBeFalsy();
    expect(full.approval.active).toBe(false);
    expect(full.approval.approvers).toHaveLength(0);
  });

});
