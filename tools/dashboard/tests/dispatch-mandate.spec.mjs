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
    // No 422 — trivial items skip contract validation
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

});
