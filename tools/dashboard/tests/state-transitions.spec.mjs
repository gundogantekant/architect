/**
 * State Machine Contract Tests
 *
 * Validates the 10-state work item state machine: transitions, flag blocking,
 * approval workflows, stakeholder projection, and invariants.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedWorkItem, api } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

async function patchStatus(id, status, extraBody = {}) {
  return fetch(`${getBase()}/api/work-items/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status, ...extraBody }),
  });
}

async function expectTransition(id, toStatus, extraBody = {}) {
  const resp = await patchStatus(id, toStatus, extraBody);
  expect(resp.ok, `transition to ${toStatus} should succeed`).toBe(true);
  const body = await resp.json();
  expect(body.status).toBe(toStatus);
  return body;
}

async function expectRejectedTransition(id, toStatus) {
  const resp = await patchStatus(id, toStatus);
  expect(resp.status).toBe(400);
  const body = await resp.json();
  return body;
}

async function walkToState(id, targetStatus) {
  const path = {
    draft: [],
    planned: ['planned'],
    'in-progress': ['planned', 'in-progress'],
    blocked: ['planned', 'in-progress', 'blocked'],
    'in-review': ['planned', 'in-progress', 'in-review'],
    testing: ['planned', 'in-progress', 'in-review', 'testing'],
    preview: ['planned', 'in-progress', 'in-review', 'testing', 'preview'],
    done: ['planned', 'in-progress', 'in-review', 'testing', 'preview', 'done'],
  }[targetStatus];
  for (const step of path) await expectTransition(id, step);
}

test.describe('State machine contracts @fast', () => {

  test('SM-1: full lifecycle draft→planned→in-progress→in-review→testing→preview→done', async () => {
    const item = await seedWorkItem({ title: 'SM-1 full lifecycle' });
    expect(item.status).toBe('draft');
    await expectTransition(item.id, 'planned');
    await expectTransition(item.id, 'in-progress');
    await expectTransition(item.id, 'in-review');
    await expectTransition(item.id, 'testing');
    await expectTransition(item.id, 'preview');
    const final = await expectTransition(item.id, 'done');
    expect(final.status).toBe('done');
  });

  test('SM-2: invalid transition draft→in-progress returns 400 with valid_targets', async () => {
    const item = await seedWorkItem({ title: 'SM-2 invalid transition' });
    const body = await expectRejectedTransition(item.id, 'in-progress');
    expect(body.from).toBe('draft');
    expect(body.attempted).toBe('in-progress');
    expect(Array.isArray(body.valid_targets)).toBe(true);
    expect(body.valid_targets).toContain('planned');
    expect(body.valid_targets).toContain('cancelled');
  });

  test('SM-3: input_needed flag blocks forward, resolves on clear', async () => {
    const item = await seedWorkItem({ title: 'SM-3 input flag' });
    await walkToState(item.id, 'in-progress');
    await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'alice', reason: 'needs clarification' }),
    });
    await expectRejectedTransition(item.id, 'in-review');
    await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false }),
    });
    await expectTransition(item.id, 'in-review');
  });

  test('SM-4: approval flag (all mode) blocks until all approvers approve', async () => {
    const item = await seedWorkItem({ title: 'SM-4 approvals' });
    await walkToState(item.id, 'testing');
    const a1 = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'alice', sort_order: 0 }),
    });
    const a2 = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'bob', sort_order: 1 }),
    });
    await expectRejectedTransition(item.id, 'preview');
    await api(`work-items/${item.id}/approvals/${a1.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    await expectRejectedTransition(item.id, 'preview');
    await api(`work-items/${item.id}/approvals/${a2.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    await expectTransition(item.id, 'preview');
  });

  test('SM-5: backward transitions work regardless of flag state', async () => {
    const item = await seedWorkItem({ title: 'SM-5 backward flags' });
    await walkToState(item.id, 'in-review');
    await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'alice', reason: 'bug found' }),
    });
    const res = await expectTransition(item.id, 'in-progress');
    expect(res.status).toBe('in-progress');

    const item2 = await seedWorkItem({ title: 'SM-5 preview→in-progress' });
    await walkToState(item2.id, 'preview');
    await fetch(`${getBase()}/api/work-items/${item2.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'alice', reason: 'rework' }),
    });
    await expectTransition(item2.id, 'in-progress');
  });

  test('SM-6: cancellation and reopening', async () => {
    const item = await seedWorkItem({ title: 'SM-6 cancel reopen' });
    await walkToState(item.id, 'testing');
    const cancelled = await expectTransition(item.id, 'cancelled');
    expect(cancelled.status).toBe('cancelled');
    const reopened = await expectTransition(item.id, 'draft');
    expect(reopened.status).toBe('draft');
  });

  test('SM-7: POST /api/work-items defaults status to draft', async () => {
    const item = await api('work-items', {
      method: 'POST',
      body: JSON.stringify({ title: 'SM-7 default status', project_key: 'ticari/architect/main' }),
    });
    expect(item.status).toBe('draft');
  });

  test('SM-8: released metadata only settable on done', async () => {
    const item = await seedWorkItem({ title: 'SM-8 released on non-done' });
    await walkToState(item.id, 'in-progress');
    const bad = await fetch(`${getBase()}/api/work-items/${item.id}/released`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ released_version: 'v1.0' }),
    });
    expect(bad.status).toBe(400);

    const item2 = await seedWorkItem({ title: 'SM-8 released on done' });
    await walkToState(item2.id, 'done');
    const ok = await fetch(`${getBase()}/api/work-items/${item2.id}/released`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ released_version: 'v1.0' }),
    });
    expect(ok.ok).toBe(true);
    const body = await ok.json();
    expect(body.released_version).toBe('v1.0');
    expect(typeof body.released_at).toBe('string');
  });

  test('SM-9: sequential approval activates approvers one at a time', async () => {
    const item = await seedWorkItem({ title: 'SM-9 sequential' });
    await walkToState(item.id, 'testing');
    // Set sequential mode before adding approvers
    await api(`work-items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ approval_mode: 'sequential' }),
    });
    const a0 = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'alice', sort_order: 0 }),
    });
    const a1 = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'bob', sort_order: 1 }),
    });
    const a2 = await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'carol', sort_order: 2 }),
    });

    // Only approver with lowest sort_order accepts decisions
    const rejectBob = await fetch(`${getBase()}/api/work-items/${item.id}/approvals/${a1.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(rejectBob.status).toBe(400);

    await api(`work-items/${item.id}/approvals/${a0.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    // Now bob can approve
    const bobOk = await api(`work-items/${item.id}/approvals/${a1.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    expect(bobOk.status).toBe('approved');
    await api(`work-items/${item.id}/approvals/${a2.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'approved' }),
    });
    const afterAll = await api(`work-items/${item.id}`);
    expect(afterAll.approval.active).toBe(false);
  });

  test('SM-10: stakeholder projection view maps states correctly', async () => {
    const draftItem = await seedWorkItem({ title: 'SM-10 draft' });
    const doneItem = await seedWorkItem({ title: 'SM-10 done' });
    await walkToState(doneItem.id, 'done');

    const archivedItem = await seedWorkItem({ title: 'SM-10 archived' });
    await walkToState(archivedItem.id, 'done');
    await expectTransition(archivedItem.id, 'archived');

    const reviewItem = await seedWorkItem({ title: 'SM-10 review' });
    await walkToState(reviewItem.id, 'in-review');

    const resp = await fetch(`${getBase()}/api/backlog?view=stakeholder`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    const allItems = Object.values(body.projects || {}).flatMap(p => p.items || []);
    const byId = Object.fromEntries(allItems.map(it => [it.id, it]));
    expect(byId[draftItem.id].status).toBe('Requested');
    expect(byId[doneItem.id].status).toBe('Done');
    expect(byId[archivedItem.id].status).toBe('Archived');
    expect(byId[reviewItem.id].status).toBe('In Review');
  });

  test('SM-11: archive transitions — done→archived and cancelled→archived succeed; archived is terminal', async () => {
    const doneItem = await seedWorkItem({ title: 'SM-11 done→archived' });
    await walkToState(doneItem.id, 'done');
    await expectTransition(doneItem.id, 'archived');

    const cancelledItem = await seedWorkItem({ title: 'SM-11 cancelled→archived' });
    await expectTransition(cancelledItem.id, 'cancelled');
    await expectTransition(cancelledItem.id, 'archived');

    // archived → any other should be rejected
    const rejected = await expectRejectedTransition(doneItem.id, 'draft');
    expect(rejected.valid_targets).toEqual([]);
  });

  test('SM-12: planned→draft without reason returns 400; with reason logs to session_log', async () => {
    const item = await seedWorkItem({ title: 'SM-12 rollback' });
    await expectTransition(item.id, 'planned');

    const noReason = await patchStatus(item.id, 'draft');
    expect(noReason.status).toBe(400);

    const withReason = await patchStatus(item.id, 'draft', { reason: 'scope changed' });
    expect(withReason.ok).toBe(true);
    const full = await api(`work-items/${item.id}`);
    expect(full.session_log.some(l => l.summary.includes('scope changed'))).toBe(true);
  });

  test('SM-13: cross-project approval with blocking_work_item_id stays active until blocker=done', async () => {
    const blocker = await seedWorkItem({ title: 'SM-13 blocker', project_key: 'ticari/other/main' });
    const item = await seedWorkItem({ title: 'SM-13 blocked approval' });
    await walkToState(item.id, 'testing');
    await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'alice', sort_order: 0, blocking_work_item_id: blocker.id }),
    });
    await expectRejectedTransition(item.id, 'preview');
    // Move blocker to done — approval should auto-resolve
    await walkToState(blocker.id, 'done');
    // Re-check target item — approval flag should clear
    const after = await api(`work-items/${item.id}`);
    expect(after.approval.active).toBe(false);
  });

  test('SM-14: T1 fast path allows draft→planned→in-progress→done for items tagged T1', async () => {
    const item = await api('work-items', {
      method: 'POST',
      body: JSON.stringify({ title: 'SM-14 T1 fast', project_key: 'ticari/architect/main', tags: ['T1'] }),
    });
    expect(item.status).toBe('draft');
    await expectTransition(item.id, 'planned');
    await expectTransition(item.id, 'in-progress');
    const done = await expectTransition(item.id, 'done');
    expect(done.status).toBe('done');

    // Non-T1 items may not skip in-review/testing/preview
    const normal = await seedWorkItem({ title: 'SM-14 non-T1' });
    await expectTransition(normal.id, 'planned');
    await expectTransition(normal.id, 'in-progress');
    await expectRejectedTransition(normal.id, 'done');
  });

  test('SM-15: approval invariant — cannot set approval_active=1 without pending approvers', async () => {
    const item = await seedWorkItem({ title: 'SM-15 invariant' });
    await walkToState(item.id, 'testing');
    const resp = await fetch(`${getBase()}/api/work-items/${item.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_active: true }),
    });
    expect(resp.status).toBeGreaterThanOrEqual(400);
  });

  test('SM-16: formatStatusWithFlags helper — stakeholder projection includes flag modifier', async () => {
    const item = await seedWorkItem({ title: 'SM-16 flag render' });
    await walkToState(item.id, 'in-progress');
    await fetch(`${getBase()}/api/work-items/${item.id}/input-needed`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: true, from: 'alice', reason: 'question' }),
    });
    const resp = await fetch(`${getBase()}/api/backlog?view=stakeholder`);
    const body = await resp.json();
    const allItems = Object.values(body.projects || {}).flatMap(p => p.items || []);
    const found = allItems.find(i => i.id === item.id);
    expect(found.status).toMatch(/In Progress/);
    expect(found.status).toMatch(/input needed/);
  });

  test('SM-17: VALID_TRANSITIONS in constants.mjs matches rules.md transition table', async () => {
    const rulesText = readFileSync(join(ROOT, 'domain', 'rules.md'), 'utf8');
    const rulesMap = parseRulesTransitionTable(rulesText);

    // Import constants module dynamically
    const mod = await import(join(ROOT, 'tools', 'dashboard', 'constants.mjs'));
    const constantsMap = mod.VALID_TRANSITIONS;

    expect(constantsMap).toBeDefined();
    for (const [from, targets] of rulesMap) {
      const cTargets = constantsMap.get(from);
      expect(cTargets, `constants missing transitions for ${from}`).toBeDefined();
      expect([...cTargets].sort()).toEqual([...targets].sort());
    }
    expect([...constantsMap.keys()].sort()).toEqual([...rulesMap.keys()].sort());
  });

  test('SM-18: composite index idx_wia_identity_status is used for approver_pending query', async () => {
    const item = await seedWorkItem({ title: 'SM-18 index check' });
    await walkToState(item.id, 'testing');
    await api(`work-items/${item.id}/approvals`, {
      method: 'POST',
      body: JSON.stringify({ identity: 'dave', sort_order: 0 }),
    });
    const resp = await fetch(`${getBase()}/api/test/explain-query?query=approver_pending&identity=dave`);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    const planText = (body.plan || []).map(r => r.detail || '').join(' ');
    expect(planText).toMatch(/idx_wia_identity_status/);
  });
});

function parseRulesTransitionTable(text) {
  const start = text.indexOf('### State Transition Table');
  if (start < 0) throw new Error('State Transition Table section not found');
  const after = text.slice(start);
  const lines = after.split('\n');
  const map = new Map();
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith('| From ')) { inTable = true; continue; }
    if (inTable && line.startsWith('|---')) continue;
    if (inTable) {
      if (!line.startsWith('|')) break;
      const cells = line.split('|').map(c => c.trim()).filter((_, i, arr) => i !== 0 && i !== arr.length - 1);
      if (cells.length !== 2) continue;
      const from = cells[0].replace(/`/g, '');
      const targetsRaw = cells[1];
      if (targetsRaw === '—' || targetsRaw === '' || targetsRaw.startsWith('—')) { map.set(from, new Set()); continue; }
      const targets = targetsRaw.split(',').map(t => t.trim().replace(/`/g, '')).filter(t => t && t !== '—');
      map.set(from, new Set(targets));
    }
  }
  return map;
}
