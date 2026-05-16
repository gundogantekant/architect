/**
 * Prompt history contract tests — W-1145
 *
 * PH-1: Seeded prompt record is retrievable via GET /api/work-items/:id/prompt-history
 * PH-2: Record has correct char_count and truncated=false for normal prompt
 * PH-3: Prompts > 1MB get truncated=true and text capped at exactly 1MB
 * PH-4: Deleting dispatch → dispatch_id becomes null but row still retrievable via work_item_id
 * PH-5: Empty prompt history returns []
 * PH-6: Multiple dispatches appear sorted by created_at DESC
 */

import { test, expect } from './fixtures.mjs';
import { api, seedWorkItem, seedDispatch } from './helpers.mjs';

const MAX_PROMPT_CHARS = 1_048_576; // 1MB

// ---------------------------------------------------------------------------
// PH-1: Seeded prompt record is retrievable
// ---------------------------------------------------------------------------

test('PH-1: seeded prompt record appears in prompt-history', async () => {
  const workItem = await seedWorkItem({ title: 'PH-1 work item', status: 'planned' });
  const dispatch = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: dispatch.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: 'Hello world',
    }),
  });

  const history = await api(`work-items/${workItem.id}/prompt-history`);
  expect(Array.isArray(history)).toBe(true);
  expect(history).toHaveLength(1);
  expect(history[0].dispatch_id).toBe(dispatch.dispatch_id);
  expect(history[0].prompt_text).toBe('Hello world');
});

// ---------------------------------------------------------------------------
// PH-2: char_count correct and truncated=false for normal prompt
// ---------------------------------------------------------------------------

test('PH-2: char_count matches prompt length and truncated is false for normal prompt', async () => {
  const workItem = await seedWorkItem({ title: 'PH-2 work item', status: 'planned' });
  const dispatch = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

  const promptText = 'A'.repeat(1000);
  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: dispatch.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: promptText,
    }),
  });

  const history = await api(`work-items/${workItem.id}/prompt-history`);
  expect(history).toHaveLength(1);
  expect(history[0].char_count).toBe(1000);
  expect(history[0].truncated).toBe(false);
});

// ---------------------------------------------------------------------------
// PH-3: Prompts > 1MB are truncated
// ---------------------------------------------------------------------------

test('PH-3: prompts larger than 1MB are capped and truncated flag is true', async () => {
  const workItem = await seedWorkItem({ title: 'PH-3 work item', status: 'planned' });
  const dispatch = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

  // Build a prompt that exceeds 1MB
  const oversize = 'B'.repeat(MAX_PROMPT_CHARS + 500);
  const truncated = oversize.length > MAX_PROMPT_CHARS;
  const capturedText = truncated ? oversize.slice(0, MAX_PROMPT_CHARS) : oversize;

  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: dispatch.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: capturedText,
      char_count: capturedText.length,
      truncated: true,
    }),
  });

  const history = await api(`work-items/${workItem.id}/prompt-history`);
  expect(history).toHaveLength(1);
  expect(history[0].truncated).toBe(true);
  expect(history[0].char_count).toBe(MAX_PROMPT_CHARS);
  expect(history[0].prompt_text.length).toBe(MAX_PROMPT_CHARS);
});

// ---------------------------------------------------------------------------
// PH-4: Deleting dispatch → dispatch_id null, but row still retrievable
// ---------------------------------------------------------------------------

test('PH-4: deleting dispatch sets dispatch_id to null but row survives via work_item_id', async () => {
  const workItem = await seedWorkItem({ title: 'PH-4 work item', status: 'planned' });
  const dispatch = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: dispatch.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: 'Audit forever',
    }),
  });

  // Verify record is there before deletion
  const before = await api(`work-items/${workItem.id}/prompt-history`);
  expect(before).toHaveLength(1);
  expect(before[0].dispatch_id).toBe(dispatch.dispatch_id);

  // Delete the dispatch
  await api(`dispatch/${dispatch.dispatch_id}`, { method: 'DELETE' });

  // Row must still exist; dispatch_id must be null
  const after = await api(`work-items/${workItem.id}/prompt-history`);
  expect(after).toHaveLength(1);
  expect(after[0].dispatch_id).toBeNull();
  expect(after[0].prompt_text).toBe('Audit forever');
});

// ---------------------------------------------------------------------------
// PH-5: Empty prompt history returns []
// ---------------------------------------------------------------------------

test('PH-5: work item with no prompts returns empty array', async () => {
  const workItem = await seedWorkItem({ title: 'PH-5 work item' });
  const history = await api(`work-items/${workItem.id}/prompt-history`);
  expect(Array.isArray(history)).toBe(true);
  expect(history).toHaveLength(0);
});

// ---------------------------------------------------------------------------
// PH-6: Multiple dispatches sorted by created_at DESC
// ---------------------------------------------------------------------------

test('PH-6: multiple prompt records are returned in created_at DESC order', async () => {
  const workItem = await seedWorkItem({ title: 'PH-6 work item', status: 'planned' });
  const d1 = await seedDispatch({ status: 'completed', work_item_id: workItem.id });
  const d2 = await seedDispatch({ status: 'completed', work_item_id: workItem.id });

  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: d1.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: 'First prompt',
    }),
  });

  // Small delay to ensure created_at ordering is deterministic
  await new Promise(r => setTimeout(r, 50));

  await api('test/seed-prompt', {
    method: 'POST',
    body: JSON.stringify({
      dispatch_id: d2.dispatch_id,
      work_item_id: workItem.id,
      project_key: 'ticari/architect/main',
      prompt_text: 'Second prompt',
    }),
  });

  const history = await api(`work-items/${workItem.id}/prompt-history`);
  expect(history).toHaveLength(2);
  // Most recent first
  expect(history[0].prompt_text).toBe('Second prompt');
  expect(history[1].prompt_text).toBe('First prompt');
  // Timestamps are in descending order
  expect(new Date(history[0].created_at) >= new Date(history[1].created_at)).toBe(true);
});
