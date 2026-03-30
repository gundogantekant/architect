/**
 * API Contract Tests
 *
 * Headless tests — no browser required. Validates that all major REST endpoints
 * return the expected shapes and status codes.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { purgeAll, seedWorkItem, api } from './helpers.mjs';

test.describe('API contracts @fast', () => {
  test.beforeEach(async () => { await purgeAll(); });

  test('AC-1: GET /api/registry returns 200', async () => {
    const result = await api('registry');
    expect(result).toBeDefined();
  });

  test('AC-2: GET /api/backlog returns projects map', async () => {
    const result = await api('backlog');
    expect(result).toBeDefined();
    expect(typeof result.projects).toBe('object');
  });

  test('AC-3: POST /api/work-items creates item', async () => {
    const item = await api('work-items', {
      method: 'POST',
      body: JSON.stringify({ title: 'AC-3 item', status: 'open', priority: 'medium', project_key: 'ticari/architect/main' }),
    });
    expect(item.id).toBeTruthy();
    expect(item.title).toBe('AC-3 item');
  });

  test('AC-4: PATCH /api/work-items/:id updates status', async () => {
    const item = await seedWorkItem({ title: 'PATCH test' });
    const updated = await api(`work-items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'done' }),
    });
    expect(updated.status).toBe('done');
  });

  test('AC-5: DELETE /api/work-items/:id removes item', async () => {
    const item = await seedWorkItem({ title: 'Delete test' });
    await api(`work-items/${item.id}`, { method: 'DELETE' });
    const backlog = await api('backlog');
    const allItems = Object.values(backlog.projects || {}).flatMap(p => p.items || []);
    expect(allItems.find(i => i.id === item.id)).toBeUndefined();
  });

  test('AC-6: GET /api/epics returns array', async () => {
    const result = await api('epics');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-7: GET /api/dispatch/active returns array', async () => {
    const result = await api('dispatch/active');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-8: GET /api/terminal/active returns array', async () => {
    const result = await api('terminal/active');
    expect(Array.isArray(result)).toBe(true);
  });

  test('AC-9: GET /api/server/status returns pid and port', async () => {
    const result = await api('server/status');
    expect(typeof result.pid).toBe('number');
    expect(typeof result.port).toBe('number');
  });

  test('AC-10: DELETE nonexistent work item returns 404', async () => {
    // api() throws on non-ok status, so we call fetch directly
    const BASE = `http://127.0.0.1:${process.env.TEST_SERVER_PORT || 3778}`;
    const resp = await fetch(`${BASE}/api/work-items/nonexistent-id-99999`, { method: 'DELETE' });
    expect(resp.status).toBe(404);
  });
});
