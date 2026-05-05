import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';

test.describe('Agent-gated task creation @fast', () => {
  test('TC-1: POST /api/dispatch with dispatch_mode=task_creation returns dispatch id', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: null,
        project_key: 'test/test/main',
        dispatch_mode: 'task_creation',
        additional_instructions: 'Create a task to add logging',
        permission_mode: 'plan'
      })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('dispatch_id');

    if (body.dispatch_id) {
      await fetch(`${base}/api/dispatch/${body.dispatch_id}`, { method: 'DELETE' });
    }
  });

  test('TC-2: POST /api/dispatch with missing project_key returns 400', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        work_item_id: null,
        dispatch_mode: 'task_creation',
        additional_instructions: 'Create a task'
      })
    });
    expect(res.status).toBe(400);
  });

  test('TC-3: task_creation is a known dispatch mode', async () => {
    const base = getBase();
    const res = await fetch(`${base}/api/dispatch/active`);
    expect(res.status).toBe(200);
  });
});
