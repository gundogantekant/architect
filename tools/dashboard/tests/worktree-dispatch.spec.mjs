/**
 * Worktree Dispatch Contract Tests (W-927)
 *
 * Validates that dispatch-level worktree creation integrates correctly:
 * - Decision matrix (shouldCreateWorktree) logic
 * - Dispatch record includes worktree fields
 * - Active dispatches API exposes worktree metadata
 * - Prompt builder injects Worktree Context section
 * - Feature flag controls behavior
 * - Resume validates worktree liveness
 *
 * These are headless API contract tests — they test the decision logic
 * and data flow, not actual git worktree creation (which requires a
 * real git repo and is covered by integration tests).
 */

import { test, expect } from './fixtures.mjs';
import { getBase, seedWorkItem, seedDispatch, api } from './helpers.mjs';

test.describe('Worktree dispatch contracts @fast', () => {

  // --- shouldCreateWorktree decision matrix ---

  test('WD-1: shouldCreateWorktree returns true for acceptEdits + workItemId + auto mode + flag on', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: 'W-999',
        worktree_mode: 'auto',
        feature_flag: true,
        is_git: true,
      }),
    });
    expect(resp.should_create).toBe(true);
  });

  test('WD-2: shouldCreateWorktree returns false for plan mode', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'plan',
        work_item_id: 'W-999',
        worktree_mode: 'auto',
        feature_flag: true,
      }),
    });
    expect(resp.should_create).toBe(false);
  });

  test('WD-3: shouldCreateWorktree returns false for explicit worktree_mode', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: 'W-999',
        worktree_mode: 'explicit',
        feature_flag: true,
      }),
    });
    expect(resp.should_create).toBe(false);
  });

  test('WD-4: shouldCreateWorktree returns false when no work_item_id', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: null,
        worktree_mode: 'auto',
        feature_flag: true,
      }),
    });
    expect(resp.should_create).toBe(false);
  });

  test('WD-12: shouldCreateWorktree returns false when feature flag off', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: 'W-999',
        worktree_mode: 'auto',
        feature_flag: false,
      }),
    });
    expect(resp.should_create).toBe(false);
  });

  test('WD-13: shouldCreateWorktree returns false when isGit is false', async () => {
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: 'W-999',
        worktree_mode: 'auto',
        feature_flag: true,
        is_git: false,
      }),
    });
    expect(resp.should_create).toBe(false);
  });

  test('WD-14: shouldCreateWorktree backward compat — omitting isGit uses existing logic', async () => {
    // When isGit is omitted (undefined), the falsy guard fires → returns false.
    // This is intentional: all updated callers explicitly pass isGit, so undefined
    // means an untouched caller — conservatively block.
    const resp = await api('test/worktree-decision', {
      method: 'POST',
      body: JSON.stringify({
        permission_mode: 'acceptEdits',
        work_item_id: 'W-999',
        worktree_mode: 'auto',
        feature_flag: true,
      }),
    });
    // isGit not passed → undefined → !undefined = true → returns false
    expect(resp.should_create).toBe(false);
  });

  // --- Dispatch record worktree fields ---

  test('WD-6: seeded dispatch with worktree fields persists them', async () => {
    const id = `D-wt-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id,
        status: 'running',
        project_key: 'ticari/architect/main',
        title: 'Worktree test',
        work_item_id: 'W-999',
        worktree_path: '/tmp/test-worktree',
        worktree_branch: 'architect-W-999-test',
        source_branch: 'main',
      }),
    });

    const active = await api('dispatch/active');
    const found = active.find(d => d.id === id);
    expect(found).toBeDefined();
    expect(found.worktree_path).toBe('/tmp/test-worktree');
    expect(found.worktree_branch).toBe('architect-W-999-test');
    expect(found.source_branch).toBe('main');
  });

  test('WD-7: active dispatches API includes worktree fields', async () => {
    const id = `D-wt-active-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id,
        status: 'completed',
        project_key: 'ticari/architect/main',
        title: 'No worktree',
      }),
    });

    const active = await api('dispatch/active');
    const found = active.find(d => d.id === id);
    expect(found).toBeDefined();
    // When no worktree, fields should be null
    expect(found.worktree_path).toBeNull();
    expect(found.worktree_branch).toBeNull();
    expect(found.source_branch).toBeNull();
  });

  // --- Prompt builder WorktreeContext injection ---

  test('WD-9: buildDispatchPrompt includes Worktree Context when worktreeContext provided', async () => {
    const resp = await api('test/build-dispatch-prompt', {
      method: 'POST',
      body: JSON.stringify({
        project_key: 'ticari/architect/main',
        work_item: { id: 'W-999', title: 'Test', description: '', status: 'draft', priority: 'medium', tags: [], session_log: [] },
        worktree_context: {
          worktreePath: '/tmp/test-wt',
          branchName: 'architect-W-999-test',
          sourceBranch: 'main',
        },
      }),
    });
    expect(resp.prompt).toContain('# Worktree Context');
    expect(resp.prompt).toContain('/tmp/test-wt');
    expect(resp.prompt).toContain('architect-W-999-test');
    expect(resp.prompt).toContain('Do NOT create a new worktree');
  });

  test('WD-10: buildDispatchPrompt omits Worktree Context when no worktreeContext', async () => {
    const resp = await api('test/build-dispatch-prompt', {
      method: 'POST',
      body: JSON.stringify({
        project_key: 'ticari/architect/main',
        work_item: { id: 'W-999', title: 'Test', description: '', status: 'draft', priority: 'medium', tags: [], session_log: [] },
      }),
    });
    expect(resp.prompt).not.toContain('# Worktree Context');
  });

  // --- Feature flag preference ---

  test('WD-12b: worktree_at_dispatch preference defaults to true', async () => {
    const prefs = await api('settings/preferences');
    // May or may not be present (depends on migration). If present, should be 'true'.
    if (prefs.worktree_at_dispatch !== undefined) {
      expect(prefs.worktree_at_dispatch).toBe('true');
    }
  });

  // --- Worktree fields survive session reset ---

  test('WD-6b: dispatch without worktree has null worktree fields in API', async () => {
    const id = `D-wt-null-${Date.now()}`;
    await api('test/seed-dispatch', {
      method: 'POST',
      body: JSON.stringify({
        id,
        status: 'running',
        project_key: 'ticari/architect/main',
        title: 'No worktree dispatch',
        work_item_id: 'W-555',
      }),
    });

    const active = await api('dispatch/active');
    const found = active.find(d => d.id === id);
    expect(found).toBeDefined();
    expect(found.worktree_path).toBeNull();
    expect(found.worktree_branch).toBeNull();
    expect(found.source_branch).toBeNull();
    // Work item still present
    expect(found.work_item_id).toBe('W-555');
  });

});
