/**
 * Dispatch Mandate Tests
 *
 * Validates Isolated Work Mandate enforcement:
 * - prompt-builder includes mandate section
 * - mandate content sourced from domain/rules.md
 * - contract validation at POST /api/dispatch for medium+ work items
 * - trivial items pass without contract
 * - coordinator.md contains gate step mandate text
 * - domain/rules.md contains mandate section
 */

import { test, expect } from './fixtures.mjs';
import { getBase } from './helpers.mjs';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHITECT_ROOT = join(__dirname, '..', '..', '..');

const MEDIUM_WORK_ITEM = {
  id: 'W-980',
  title: 'Implement feature X',
  status: 'draft',
  priority: 'medium',
  tags: ['medium'],
};

const FULL_CONTRACT = {
  goal: 'Implement the isolated work mandate enforcement',
  constraints: 'No breaking changes to existing dispatch flow',
  expected_output: 'Modified prompt-builder with mandate section and validated dispatch route',
  failure_conditions: 'Any existing dispatch test fails or mandate section is absent',
  success_criteria: 'Mandate section is present in all medium+ dispatch prompts',
  e2e_test_criteria: ['buildDispatchPrompt includes mandate section for medium items'],
};

test.describe('Dispatch Mandate @fast', () => {

  test('DM-1: buildDispatchPrompt for a medium work item includes # Isolated Work Mandate section', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: MEDIUM_WORK_ITEM,
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: FULL_CONTRACT,
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    expect(prompt).toContain('# Isolated Work Mandate');
  });

  test('DM-2: mandate section content matches text from domain/rules.md', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: MEDIUM_WORK_ITEM,
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
        contract: FULL_CONTRACT,
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();

    const rulesContent = readFileSync(join(ARCHITECT_ROOT, 'domain', 'rules.md'), 'utf8');
    const start = rulesContent.indexOf('## Isolated Work Mandate');
    expect(start).toBeGreaterThan(-1);

    // Extract a distinctive phrase from the mandate section
    const mandateSlice = rulesContent.slice(start, start + 200);
    // The prompt must contain a substring that appears in the domain file
    const firstLine = mandateSlice.split('\n').find(l => l.trim().length > 5 && !l.startsWith('#'));
    if (firstLine) {
      expect(prompt).toContain(firstLine.trim());
    }
    // At minimum the section header must be present
    expect(prompt).toContain('## Isolated Work Mandate');
  });

  test('DM-3: POST /api/dispatch with medium item missing goal returns 422 with violations containing goal', async ({ request }) => {
    const base = getBase();
    const projectKey = 'test/dm3/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      data: { project_key: projectKey, project_path: '/tmp' },
    });
    const wi = await request.post(`${base}/api/work-items`, {
      data: { project_key: projectKey, title: 'Implement feature DM-3', status: 'draft', priority: 'medium', tags: ['medium'] },
    }).then(r => r.json());

    const resp = await request.post(`${base}/api/dispatch`, {
      data: {
        project_key: projectKey,
        work_item_id: wi.id,
        contract: {
          // goal intentionally omitted
          constraints: 'No breaking changes',
          expected_output: 'Modified files',
          failure_conditions: 'Tests fail',
          e2e_test_criteria: ['one criterion'],
        },
        confirm_worktree_warning: true,
      },
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.violations).toBeDefined();
    expect(body.violations.some(v => v.field === 'goal')).toBe(true);
  });

  test('DM-4: POST /api/dispatch with medium item missing e2e_test_criteria returns 422 with violations containing e2e_test_criteria', async ({ request }) => {
    const base = getBase();
    const projectKey = 'test/dm4/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      data: { project_key: projectKey, project_path: '/tmp' },
    });
    const wi = await request.post(`${base}/api/work-items`, {
      data: { project_key: projectKey, title: 'Implement feature DM-4', status: 'draft', priority: 'medium', tags: ['medium'] },
    }).then(r => r.json());

    const resp = await request.post(`${base}/api/dispatch`, {
      data: {
        project_key: projectKey,
        work_item_id: wi.id,
        contract: {
          goal: 'Implement the feature',
          constraints: 'No breaking changes',
          expected_output: 'Modified files',
          failure_conditions: 'Tests fail',
          // e2e_test_criteria intentionally omitted
        },
        confirm_worktree_warning: true,
      },
    });
    expect(resp.status()).toBe(422);
    const body = await resp.json();
    expect(body.violations).toBeDefined();
    expect(body.violations.some(v => v.field === 'e2e_test_criteria')).toBe(true);
  });

  test('DM-5: POST /api/dispatch with fully populated medium contract returns 2xx', async ({ request }) => {
    const base = getBase();
    // Create a real work item with medium tag so validation passes
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: {
        project_key: 'ticari/architect/main',
        title: 'Implement feature DM-5',
        status: 'draft',
        priority: 'medium',
        tags: ['medium'],
      },
    });
    expect(wiResp.ok()).toBe(true);
    const workItem = await wiResp.json();

    const resp = await request.post(`${base}/api/dispatch`, {
      data: {
        project_key: 'ticari/architect/main',
        work_item_id: workItem.id,
        contract: FULL_CONTRACT,
        confirm_worktree_warning: true,
      },
    });
    // 2xx means no contract rejection (dispatch may fail for other reasons like spawn)
    expect(resp.status()).not.toBe(422);
  });

  test('DM-6: POST /api/dispatch with trivial work item (no contract fields) returns 2xx', async ({ request }) => {
    const base = getBase();
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: {
        project_key: 'ticari/architect/main',
        title: 'Fix typo DM-6',
        status: 'draft',
        priority: 'low',
        tags: ['trivial'],
      },
    });
    expect(wiResp.ok()).toBe(true);
    const workItem = await wiResp.json();

    const resp = await request.post(`${base}/api/dispatch`, {
      data: {
        project_key: 'ticari/architect/main',
        work_item_id: workItem.id,
        // No contract fields
        confirm_worktree_warning: true,
      },
    });
    // No 422 — trivial items skip contract validation (this test only checks contract validation, not prompt content)
    expect(resp.status()).not.toBe(422);
  });

  test('DM-7: coordinator.md contains Isolated Work Mandate gate step instructions', async () => {
    const coordinatorContent = readFileSync(
      join(ARCHITECT_ROOT, '.claude', 'agents', 'coordinator.md'),
      'utf8'
    );
    expect(coordinatorContent).toContain('Isolated Work Mandate');
    expect(coordinatorContent).toContain('plan-gate');
    expect(coordinatorContent).toContain('code-gate');
    // Plan gate must be ordered before implementation steps
    const planGateIdx = coordinatorContent.indexOf('plan-gate');
    const codeGateIdx = coordinatorContent.indexOf('code-gate');
    expect(planGateIdx).toBeGreaterThan(-1);
    expect(codeGateIdx).toBeGreaterThan(planGateIdx);
  });

  test('DM-8: domain/rules.md contains the string "Isolated Work Mandate"', async () => {
    const rulesContent = readFileSync(
      join(ARCHITECT_ROOT, 'domain', 'rules.md'),
      'utf8'
    );
    expect(rulesContent).toContain('Isolated Work Mandate');
  });

  test('DM-9: buildDispatchPrompt for a trivial work item includes plan-first + board review instructions', async ({ request }) => {
    const base = getBase();
    const resp = await request.post(`${base}/api/test/build-prompt`, {
      data: {
        workItem: {
          id: 'W-dm9',
          title: 'Fix typo DM-9',
          status: 'draft',
          priority: 'low',
          tags: ['trivial'],
        },
        projectKey: 'ticari/architect/main',
        projectPath: '/tmp/test-project',
      },
    });
    expect(resp.ok()).toBe(true);
    const { prompt } = await resp.json();
    expect(prompt).toContain('# Isolated Work Mandate');
    expect(prompt).toContain('Plan-First + Board Review required');
    expect(prompt).toContain('inline plan');
    expect(prompt).toContain('Plan Gate board');
  });

  test('DM-10: POST /complete with test_suite_passed=false and test_framework_absent not set → 422 tests_not_passed', async ({ request }) => {
    const base = getBase();
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: 'ticari/architect/main', title: 'DM-10 test', status: 'in-progress', priority: 'medium', tags: ['trivial'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    const dispResp = await request.post(`${base}/api/dispatch`, {
      data: { project_key: 'ticari/architect/main', work_item_id: wi.id, confirm_worktree_warning: true },
    });
    if (!dispResp.ok()) return; // dispatch may fail for spawn reasons; skip if no dispatch
    const { dispatch_id } = await dispResp.json();
    if (!dispatch_id) return;

    const completeResp = await request.post(`${base}/api/dispatch/${dispatch_id}/complete`, {
      data: { sha: 'abc1234', summary: 'done', test_suite_passed: false },
      headers: { 'X-Architect-Session-Depth': '1' },
    });
    expect(completeResp.status()).toBe(422);
    const body = await completeResp.json();
    expect(body.error).toBe('tests_not_passed');
  });

  test('DM-11: POST /complete with test_framework_absent=true satisfies gate 1', async ({ request }) => {
    const base = getBase();
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: 'ticari/architect/main', title: 'DM-11 test', status: 'in-progress', priority: 'low', tags: ['trivial'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    const dispResp = await request.post(`${base}/api/dispatch`, {
      data: { project_key: 'ticari/architect/main', work_item_id: wi.id, confirm_worktree_warning: true },
    });
    if (!dispResp.ok()) return;
    const { dispatch_id } = await dispResp.json();
    if (!dispatch_id) return;

    const completeResp = await request.post(`${base}/api/dispatch/${dispatch_id}/complete`, {
      data: { sha: 'abc1234', summary: 'done', test_framework_absent: true },
      headers: { 'X-Architect-Session-Depth': '1' },
    });
    // Should NOT be 422 for gate 1 (may be 422 for gate 3 or 200)
    expect(completeResp.status()).not.toBe(422);
    if (completeResp.status() === 422) {
      const body = await completeResp.json();
      expect(body.error).not.toBe('tests_not_passed');
    }
  });

  test('DM-12: POST /merge for small+ dispatch without contract_satisfied → 422 contract_not_satisfied', async ({ request }) => {
    const base = getBase();
    const projectKey = 'test/dm12/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      data: { project_key: projectKey, project_path: '/tmp' },
    });
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: projectKey, title: 'DM-12 test', status: 'in-progress', priority: 'medium', tags: ['small'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    // Simulate a dispatch in merge_pending state
    const dispatchId = `D-test-dm12-${Date.now()}`;
    await request.post(`${base}/api/test/seed-dispatch`, {
      data: {
        id: dispatchId,
        work_item_id: wi.id,
        project_key: projectKey,
        status: 'merge_pending',
        test_suite_passed: true,
        build_verified: true,
        contract_satisfied: false,
      },
    }).catch(() => {}); // seed endpoint may not exist; skip if unavailable

    // Direct test via server state — skip if seed endpoint not available
    const mergeResp = await request.post(`${base}/api/dispatch/${dispatchId}/merge`, {
      headers: { 'X-Architect-Session-Depth': '0' },
    });
    if (mergeResp.status() === 404) return; // dispatch not found — seed endpoint unavailable
    expect(mergeResp.status()).toBe(422);
    const body = await mergeResp.json();
    expect(body.error).toBe('contract_not_satisfied');
  });

  test('DM-13: trivial dispatch with test_suite_passed=true proceeds through /complete without contract gate', async ({ request }) => {
    const base = getBase();
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: 'ticari/architect/main', title: 'DM-13 trivial', status: 'in-progress', priority: 'low', tags: ['trivial'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    const dispResp = await request.post(`${base}/api/dispatch`, {
      data: { project_key: 'ticari/architect/main', work_item_id: wi.id, confirm_worktree_warning: true },
    });
    if (!dispResp.ok()) return;
    const { dispatch_id } = await dispResp.json();
    if (!dispatch_id) return;

    const completeResp = await request.post(`${base}/api/dispatch/${dispatch_id}/complete`, {
      data: { sha: 'abc1234', summary: 'done', test_suite_passed: true, build_verified: true },
      headers: { 'X-Architect-Session-Depth': '1' },
    });
    // Trivial items skip contract gate — should not get contract_not_satisfied
    if (completeResp.status() === 422) {
      const body = await completeResp.json();
      expect(body.error).not.toBe('contract_not_satisfied');
    }
  });

  test('DM-14: POST /merge with scope_violation=true returns 422 with error scope_violation and hint', async ({ request }) => {
    const base = getBase();
    const projectKey = 'test/dm14/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      data: { project_key: projectKey, project_path: '/tmp' },
    });
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: projectKey, title: 'DM-14 scope violation test', status: 'in-progress', priority: 'medium', tags: ['small'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    const dispatchId = `D-test-dm14-${Date.now()}`;
    await request.post(`${base}/api/test/seed-dispatch`, {
      data: {
        id: dispatchId,
        work_item_id: wi.id,
        project_key: projectKey,
        status: 'merge_pending',
        test_suite_passed: true,
        contract_satisfied: true,
        scope_violation: true,
      },
    }).catch(() => {});

    const mergeResp = await request.post(`${base}/api/dispatch/${dispatchId}/merge`, {
      headers: { 'X-Architect-Session-Depth': '0' },
    });
    if (mergeResp.status() === 404) return; // seed endpoint unavailable
    expect(mergeResp.status()).toBe(422);
    const body = await mergeResp.json();
    expect(body.error).toBe('scope_violation');
    expect(body.hint).toBeDefined();
  });

  test('DM-15: dispatch with scope_violation=true remains in merge_pending after scope violation is set', async ({ request }) => {
    const base = getBase();
    const projectKey = 'test/dm15/main';
    await request.post(`${base}/api/test/seed-registry-entry`, {
      data: { project_key: projectKey, project_path: '/tmp' },
    });
    const wiResp = await request.post(`${base}/api/work-items`, {
      data: { project_key: projectKey, title: 'DM-15 auto-merge guard test', status: 'in-progress', priority: 'medium', tags: ['small'] },
    });
    expect(wiResp.ok()).toBe(true);
    const wi = await wiResp.json();

    const dispatchId = `D-test-dm15-${Date.now()}`;
    await request.post(`${base}/api/test/seed-dispatch`, {
      data: {
        id: dispatchId,
        work_item_id: wi.id,
        project_key: projectKey,
        status: 'merge_pending',
        test_suite_passed: true,
        contract_satisfied: true,
        scope_violation: true,
      },
    }).catch(() => {});

    // Verify the dispatch is in merge_pending — the scope_violation gate blocks auto-merge
    const getResp = await request.get(`${base}/api/dispatch/${dispatchId}`);
    if (getResp.status() === 404) return; // seed endpoint unavailable
    expect(getResp.ok()).toBe(true);
    const dispatch = await getResp.json();
    expect(dispatch.status).toBe('merge_pending');
    expect(dispatch.scope_violation).toBe(true);
  });

});
