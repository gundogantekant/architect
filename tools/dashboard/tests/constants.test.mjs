import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..');

/**
 * SM-18 / SM-19: contract tests for status eligibility constants.
 *
 * AUTO_IMPLEMENTABLE_STATUSES and DISPATCHABLE_STATUSES are the single source
 * of truth for dispatch eligibility rules (domain/rules.md → Auto-Implement
 * Eligibility Rules). These tests catch silent value drift without requiring a
 * running server.
 */

test('SM-18: AUTO_IMPLEMENTABLE_STATUSES is exactly [planned, in-progress]', async () => {
  const { AUTO_IMPLEMENTABLE_STATUSES } = await import(join(ROOT, 'tools/dashboard/constants.mjs'));
  assert.deepStrictEqual(
    [...AUTO_IMPLEMENTABLE_STATUSES],
    ['planned', 'in-progress'],
    'blocked and draft must be excluded: humans block/plan, automation must not bypass',
  );
  assert.ok(!AUTO_IMPLEMENTABLE_STATUSES.includes('blocked'), 'blocked must not be auto-implementable');
  assert.ok(!AUTO_IMPLEMENTABLE_STATUSES.includes('draft'), 'draft requires human plan-gate first');
});

test('SM-19: AUTO_IMPLEMENTABLE_STATUSES is a strict subset of DISPATCHABLE_STATUSES', async () => {
  const { DISPATCHABLE_STATUSES, AUTO_IMPLEMENTABLE_STATUSES } = await import(join(ROOT, 'tools/dashboard/constants.mjs'));
  assert.deepStrictEqual(
    [...DISPATCHABLE_STATUSES],
    ['draft', 'planned', 'in-progress', 'blocked'],
  );
  for (const s of AUTO_IMPLEMENTABLE_STATUSES) {
    assert.ok(
      DISPATCHABLE_STATUSES.includes(s),
      `AUTO_IMPLEMENTABLE status '${s}' must be a member of DISPATCHABLE_STATUSES`,
    );
  }
  assert.ok(
    DISPATCHABLE_STATUSES.length > AUTO_IMPLEMENTABLE_STATUSES.length,
    'DISPATCHABLE_STATUSES must be strictly larger than AUTO_IMPLEMENTABLE_STATUSES',
  );
});
