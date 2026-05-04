/**
 * Approval CRUD contract tests (AP-1 – AP-5).
 *
 * Validates the response body structure of the approval API endpoints introduced
 * by W-951. The state-transitions.spec tests (SM-4, SM-9, SM-10) cover behavioral
 * correctness (blocks/unblocks transitions); these tests focus on the CRUD contract:
 * shape of created records, list response format, and GET work-item hydration.
 */

import { test, expect } from './fixtures.mjs';
import { seedWorkItem, api, getBase } from './helpers.mjs';

test.describe('Approval CRUD contracts @fast', () => {

  test('AP-1: POST creates approval with correct fields', async () => {
    const item = await seedWorkItem({ title: 'AP-1 create approval', status: 'in-progress' });
    const approval = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'reviewer@example.com', sort_order: 0 }),
    });
    expect(typeof approval.id).toBe('number');
    expect(approval.work_item_id).toBe(item.id);
    expect(approval.identity).toBe('reviewer@example.com');
    expect(approval.status).toBe('pending');
    expect(approval.sort_order).toBe(0);
    expect(approval.decided_at).toBeFalsy();
    expect(approval.reason).toBeFalsy();
    expect(typeof approval.created_at).toBe('string');
  });

  test('AP-2: GET list returns array with correct structure', async () => {
    const item = await seedWorkItem({ title: 'AP-2 list approvals', status: 'in-progress' });
    await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'alice@example.com', sort_order: 0 }),
    });
    await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'bob@example.com', sort_order: 1 }),
    });

    const list = await api(`work-items/${item.id}/approvals`);
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(2);
    for (const a of list) {
      expect(typeof a.id).toBe('number');
      expect(a.work_item_id).toBe(item.id);
      expect(typeof a.identity).toBe('string');
      expect(['pending', 'approved', 'rejected']).toContain(a.status);
      expect(typeof a.sort_order).toBe('number');
    }
    const identities = list.map(a => a.identity).sort();
    expect(identities).toEqual(['alice@example.com', 'bob@example.com'].sort());
  });

  test('AP-3: PATCH approve stores decision fields', async () => {
    const item = await seedWorkItem({ title: 'AP-3 approve', status: 'in-progress' });
    const created = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'reviewer@example.com', sort_order: 0 }),
    });

    const approved = await api(`work-items/${item.id}/approvals/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved', reason: 'LGTM' }),
    });
    expect(approved.status).toBe('approved');
    expect(approved.reason).toBe('LGTM');
    expect(typeof approved.decided_at).toBe('string');
  });

  test('AP-4: PATCH reject stores rejection fields', async () => {
    const item = await seedWorkItem({ title: 'AP-4 reject', status: 'in-progress' });
    const created = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'reviewer@example.com', sort_order: 0 }),
    });

    const rejected = await api(`work-items/${item.id}/approvals/${created.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'rejected', reason: 'needs rework' }),
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('needs rework');
    expect(typeof rejected.decided_at).toBe('string');
  });

  test('AP-5: GET work item includes nested approval object with approvers', async () => {
    const item = await seedWorkItem({ title: 'AP-5 nested approval', status: 'in-progress' });
    await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'reviewer@example.com', sort_order: 0 }),
    });

    const full = await api(`work-items/${item.id}`);
    expect(full.approval).toBeDefined();
    expect(typeof full.approval.active).toBe('boolean');
    expect(typeof full.approval.mode).toBe('string');
    expect(Array.isArray(full.approval.approvers)).toBe(true);
    expect(full.approval.approvers).toHaveLength(1);
    const [approver] = full.approval.approvers;
    expect(approver.identity).toBe('reviewer@example.com');
    expect(approver.status).toBe('pending');
  });

});
