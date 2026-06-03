/**
 * Date Columns Contract Tests (W-1008)
 *
 * TDD contract tests — these MUST FAIL before implementation.
 * They define what must be true after the migration adds done_at
 * and created_at columns to the work_items table.
 *
 * DC-6 (assertSchema): Implicit — if the test server starts successfully
 * via the Playwright fixture, assertSchema has already been run and passed.
 * No explicit test needed; server startup failure would fail all tests here.
 *
 * Prerequisite: dashboard server running (managed by global-setup.mjs).
 */

import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem } from './helpers.mjs';

// Walk a work item through the full state chain to 'done'.
// Path: draft → planned → in-progress → in-review → testing → preview → done
async function walkToDone(id) {
  for (const status of ['planned', 'in-progress', 'in-review', 'testing', 'preview', 'done']) {
    await api(`work-items/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }
}

test.describe('Work item date columns @fast', () => {

  // DC-1: Migration adds done_at column
  test('DC-1a: GET /api/work-items/:id response includes done_at field', async () => {
    const item = await seedWorkItem({ title: 'DC-1a date field present' });
    const fetched = await api(`work-items/${item.id}`);
    expect(fetched).toHaveProperty('done_at');
    // Not yet done — should be null
    expect(fetched.done_at).toBeNull();
  });

  test('DC-1b: GET /api/work-items list — each item includes done_at field', async () => {
    await seedWorkItem({ title: 'DC-1b list item' });
    const backlog = await api('backlog');
    const allItems = Object.values(backlog.projects).flatMap(p => p.items);
    expect(allItems.length).toBeGreaterThan(0);
    for (const item of allItems) {
      expect(item, `item ${item.id} should have done_at`).toHaveProperty('done_at');
    }
  });

  // DC-2: done_at is set when status transitions to 'done'
  test('DC-2: done_at is a non-null ISO timestamp after status transitions to done', async () => {
    const item = await seedWorkItem({ title: 'DC-2 done_at set', tags: ['trivial'] });
    await walkToDone(item.id);
    const fetched = await api(`work-items/${item.id}`);
    expect(fetched.status).toBe('done');
    expect(fetched.done_at).not.toBeNull();
    // Must be a valid ISO 8601 timestamp string
    expect(typeof fetched.done_at).toBe('string');
    expect(new Date(fetched.done_at).getTime()).not.toBeNaN();
  });

  // DC-3: done_at is idempotent — persists after further status changes (e.g. archiving)
  test('DC-3: done_at persists after transitioning from done to archived', async () => {
    const item = await seedWorkItem({ title: 'DC-3 idempotent done_at', tags: ['trivial'] });

    // Walk to done
    await walkToDone(item.id);
    const afterDone = await api(`work-items/${item.id}`);
    const t1 = afterDone.done_at;
    expect(t1).not.toBeNull();

    // Archive the item — valid transition from done
    await api(`work-items/${item.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'archived' }),
    });

    // done_at must still be t1 — archiving must not clear it
    const afterArchive = await api(`work-items/${item.id}`);
    expect(afterArchive.done_at).toBe(t1);
  });

  // DC-4: created_at is present in work item responses
  test('DC-4: GET /api/work-items/:id includes created_at as non-null ISO timestamp', async () => {
    const item = await seedWorkItem({ title: 'DC-4 created_at' });
    const fetched = await api(`work-items/${item.id}`);
    expect(fetched).toHaveProperty('created_at');
    expect(fetched.created_at).not.toBeNull();
    expect(typeof fetched.created_at).toBe('string');
    expect(new Date(fetched.created_at).getTime()).not.toBeNaN();
  });

  // DC-5: Work item list endpoint returns done_at and created_at per item
  test('DC-5: list endpoint returns created_at on all items and done_at non-null only on done items', async () => {
    const itemA = await seedWorkItem({ title: 'DC-5 non-done item', tags: ['trivial'] });
    const itemB = await seedWorkItem({ title: 'DC-5 done item', tags: ['trivial'] });

    // Walk itemB to done
    await walkToDone(itemB.id);

    const backlog = await api('backlog');
    const allItems = Object.values(backlog.projects).flatMap(p => p.items);

    const fetchedA = allItems.find(i => i.id === itemA.id);
    const fetchedB = allItems.find(i => i.id === itemB.id);

    expect(fetchedA, 'DC-5 non-done item must appear in backlog').toBeDefined();
    expect(fetchedB, 'DC-5 done item must appear in backlog').toBeDefined();

    // Both must have created_at
    expect(fetchedA.created_at).not.toBeNull();
    expect(typeof fetchedA.created_at).toBe('string');
    expect(new Date(fetchedA.created_at).getTime()).not.toBeNaN();

    expect(fetchedB.created_at).not.toBeNull();
    expect(typeof fetchedB.created_at).toBe('string');
    expect(new Date(fetchedB.created_at).getTime()).not.toBeNaN();

    // Non-done item: done_at must be null
    expect(fetchedA.done_at).toBeNull();

    // Done item: done_at must be a valid ISO timestamp
    expect(fetchedB.done_at).not.toBeNull();
    expect(typeof fetchedB.done_at).toBe('string');
    expect(new Date(fetchedB.done_at).getTime()).not.toBeNaN();
  });

});
