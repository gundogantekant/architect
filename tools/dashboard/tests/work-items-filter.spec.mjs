/**
 * Work Items Filter API Contracts
 *
 * Validates status, priority, epic_id, pagination, and sorting filters for:
 *   GET /api/backlog
 *   GET /api/work-items
 *
 * Regression guards for backward-compatible no-param behavior are included.
 * Tests run headless against the live test server — no browser required.
 */

import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem, seedEpic, purgeAll } from './helpers.mjs';

const PROJECT_KEY = 'ticari/architect/main';
const BASE = () => `http://127.0.0.1:${process.env.TEST_SERVER_PORT}`;

async function rawGet(path) {
  const url = `${BASE()}/api/${path}`;
  return fetch(url, { headers: { 'Content-Type': 'application/json' } });
}

test.describe('work-items filter API @headless', () => {
  test.beforeAll(async () => {
    await purgeAll();
  });

  // ============================================================
  // Backlog — status filter
  // ============================================================

  test('WIF-1: backlog?status=draft returns only draft items', async () => {
    await seedWorkItem({ title: 'WIF-1 draft', status: 'draft', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-1 planned', status: 'planned', project_key: PROJECT_KEY });

    const result = await api(`backlog?status=draft`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.status === 'draft')).toBe(true);
  });

  test('WIF-2: backlog?status=draft&status=planned returns both statuses', async () => {
    await seedWorkItem({ title: 'WIF-2 draft', status: 'draft', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-2 planned', status: 'planned', project_key: PROJECT_KEY });

    const result = await api(`backlog?status=draft&status=planned`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    const statuses = new Set(items.map(i => i.status));
    expect(statuses.has('draft')).toBe(true);
    expect(statuses.has('planned')).toBe(true);
    expect([...statuses].every(s => ['draft', 'planned'].includes(s))).toBe(true);
  });

  test('WIF-3: backlog without status param excludes archived by default (backward compat)', async () => {
    const item = await seedWorkItem({ title: 'WIF-3 draft', status: 'draft', project_key: PROJECT_KEY });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-review' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'testing' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'preview' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    await api(`work-items/${item.id}/archive`, { method: 'POST' });

    const result = await api('backlog');
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    expect(items.every(i => i.status !== 'archived')).toBe(true);
  });

  test('WIF-4: backlog?status=archived explicitly includes archived items', async () => {
    const item = await seedWorkItem({ title: 'WIF-4 archived', status: 'draft', project_key: PROJECT_KEY });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'planned' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-progress' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'in-review' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'testing' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'preview' }) });
    await api(`work-items/${item.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'done' }) });
    await api(`work-items/${item.id}/archive`, { method: 'POST' });

    const result = await api(`backlog?status=archived`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    expect(items.some(i => i.status === 'archived')).toBe(true);
    expect(items.every(i => i.status === 'archived')).toBe(true);
  });

  test('WIF-5: backlog?status=invalid returns 400', async () => {
    const resp = await rawGet('backlog?status=not_a_valid_status');
    expect(resp.status).toBe(400);
  });

  // ============================================================
  // Backlog — priority filter
  // ============================================================

  test('WIF-6: backlog?priority=high returns only high priority items', async () => {
    await seedWorkItem({ title: 'WIF-6 high', priority: 'high', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-6 low', priority: 'low', project_key: PROJECT_KEY });

    const result = await api(`backlog?priority=high`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.priority === 'high')).toBe(true);
  });

  test('WIF-7: backlog?priority=high&priority=critical returns both', async () => {
    await seedWorkItem({ title: 'WIF-7 high', priority: 'high', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-7 critical', priority: 'critical', project_key: PROJECT_KEY });

    const result = await api(`backlog?priority=high&priority=critical`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    const priorities = new Set(items.map(i => i.priority));
    expect(priorities.has('high')).toBe(true);
    expect(priorities.has('critical')).toBe(true);
    expect([...priorities].every(p => ['high', 'critical'].includes(p))).toBe(true);
  });

  test('WIF-8: backlog?priority=invalid returns 400', async () => {
    const resp = await rawGet('backlog?priority=ultra');
    expect(resp.status).toBe(400);
  });

  // ============================================================
  // Backlog — epic_id filter
  // ============================================================

  test('WIF-9: backlog?epic_id= returns only items for that epic', async () => {
    const epic = await seedEpic({ title: 'WIF-9 epic' });
    await seedWorkItem({ title: 'WIF-9 epic item', epic_id: epic.id, project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-9 no epic item', project_key: PROJECT_KEY });

    const result = await api(`backlog?epic_id=${epic.id}`);
    const items = Object.values(result.projects || {}).flatMap(g => g.items || []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every(i => i.epic_id === epic.id)).toBe(true);
  });

  // ============================================================
  // Work items — status + pagination (new envelope)
  // ============================================================

  test('WIF-10: work-items?status=draft returns { items, _meta } envelope', async () => {
    await seedWorkItem({ title: 'WIF-10 draft', status: 'draft', project_key: PROJECT_KEY });

    const result = await api(`work-items?status=draft`);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result._meta).toBeDefined();
    expect(typeof result._meta.total).toBe('number');
    expect(typeof result._meta.limit).toBe('number');
    expect(typeof result._meta.offset).toBe('number');
    expect(typeof result._meta.has_more).toBe('boolean');
    expect(result.items.every(i => i.status === 'draft')).toBe(true);
  });

  test('WIF-11: work-items?limit=2&offset=0 respects pagination and _meta.has_more', async () => {
    await purgeAll();
    await seedWorkItem({ title: 'WIF-11 a', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-11 b', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-11 c', project_key: PROJECT_KEY });

    const result = await api(`work-items?limit=2&offset=0`);
    expect(result.items.length).toBe(2);
    expect(result._meta.limit).toBe(2);
    expect(result._meta.offset).toBe(0);
    expect(result._meta.has_more).toBe(true);
    expect(result._meta.total).toBeGreaterThanOrEqual(3);
  });

  test('WIF-12: work-items?limit=2&offset=2 returns next page', async () => {
    const page1 = await api(`work-items?limit=2&offset=0`);
    const page2 = await api(`work-items?limit=2&offset=2`);

    const ids1 = page1.items.map(i => i.id);
    const ids2 = page2.items.map(i => i.id);
    expect(ids1.some(id => ids2.includes(id))).toBe(false);
  });

  test('WIF-13: work-items (no params) returns { items, _meta } with archived excluded', async () => {
    const result = await api('work-items');
    expect(Array.isArray(result.items)).toBe(true);
    expect(result._meta).toBeDefined();
    expect(result.items.every(i => i.status !== 'archived')).toBe(true);
  });

  test('WIF-14: work-items?status=invalid returns 400', async () => {
    const resp = await rawGet('work-items?status=not_valid');
    expect(resp.status).toBe(400);
  });

  test('WIF-15: work-items?sort_by=<injection> returns 400', async () => {
    const resp = await rawGet("work-items?sort_by=id%3B%20DROP%20TABLE%20work_items");
    expect(resp.status).toBe(400);
  });

  test('WIF-16: work-items?sort_by=updated_at&sort_dir=desc returns items in desc order', async () => {
    await purgeAll();
    await seedWorkItem({ title: 'WIF-16 first', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-16 second', project_key: PROJECT_KEY });

    const result = await api(`work-items?sort_by=updated_at&sort_dir=desc`);
    expect(result.items.length).toBeGreaterThanOrEqual(2);
    const dates = result.items.map(i => i.updated_at);
    for (let i = 1; i < dates.length; i++) {
      expect(dates[i] <= dates[i - 1]).toBe(true);
    }
  });

  test('WIF-17: work-items?sort_dir=invalid returns 400', async () => {
    const resp = await rawGet('work-items?sort_dir=sideways');
    expect(resp.status).toBe(400);
  });

  test('WIF-18: work-items?epic_id= returns items for that epic', async () => {
    const epic = await seedEpic({ title: 'WIF-18 epic' });
    await seedWorkItem({ title: 'WIF-18 epic item', epic_id: epic.id, project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-18 unlinked item', project_key: PROJECT_KEY });

    const result = await api(`work-items?epic_id=${epic.id}`);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(i => i.epic_id === epic.id)).toBe(true);
  });

  test('WIF-19: work-items?priority=critical returns only critical items', async () => {
    await seedWorkItem({ title: 'WIF-19 critical', priority: 'critical', project_key: PROJECT_KEY });
    await seedWorkItem({ title: 'WIF-19 low', priority: 'low', project_key: PROJECT_KEY });

    const result = await api(`work-items?priority=critical`);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(i => i.priority === 'critical')).toBe(true);
  });

  test('WIF-20: work-items?org= filters by org prefix', async () => {
    await seedWorkItem({ title: 'WIF-20 arch', project_key: 'ticari/architect/main' });
    await seedWorkItem({ title: 'WIF-20 other', project_key: 'other-org/project/main' });

    const result = await api(`work-items?org=ticari`);
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every(i => i.project_key.startsWith('ticari/'))).toBe(true);
    expect(result.items.some(i => i.project_key.startsWith('other-org/'))).toBe(false);
  });

  // ============================================================
  // Backward-compat regression: existing PKF-5 shape update
  // ============================================================

  test('WIF-PKF5-compat: work-items?project_key= returns { items } scoped to project', async () => {
    await purgeAll();
    await seedWorkItem({ title: 'WIF-PKF5 arch', project_key: 'ticari/architect/main' });
    await seedWorkItem({ title: 'WIF-PKF5 other', project_key: 'ticari/cortex/main' });

    const result = await api(`work-items?project_key=ticari%2Farchitect%2Fmain`);
    expect(Array.isArray(result.items)).toBe(true);
    expect(result.items.every(i => i.project_key === 'ticari/architect/main')).toBe(true);
    expect(result.items.some(i => i.project_key === 'ticari/cortex/main')).toBe(false);
  });
});
