/**
 * Findings Coordinator Schema Contract Tests
 *
 * Headless — no server required. Validates the three output shapes that
 * findings-coordinator can produce:
 *   1. Valid DispatchPlan with plan-gate and code-gate (medium+ path)
 *   2. DispatchPlan with clarifications_needed and no steps (confidence floor path)
 *   3. Structured error object when target_project context is missing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── Schema validators ─────────────────────────────────────────────────────────

function hasAllTargetProjectFields(tp) {
  return (
    typeof tp === 'object' && tp !== null &&
    typeof tp.organization === 'string' && tp.organization.length > 0 &&
    typeof tp.project === 'string' && tp.project.length > 0 &&
    typeof tp.component === 'string' && tp.component.length > 0 &&
    typeof tp.path === 'string' && tp.path.length > 0 &&
    typeof tp.branch === 'string' && tp.branch.length > 0
  );
}

function hasRequiredClassification(cls) {
  return (
    typeof cls === 'object' && cls !== null &&
    ['trivial', 'small', 'medium', 'large'].includes(cls.complexity) &&
    ['feature', 'bugfix', 'refactor', 'question', 'review', 'deploy', 'maintenance', 'strategic', 'investigation'].includes(cls.type) &&
    typeof cls.confidence === 'number'
  );
}

function hasValidContract(contract) {
  return (
    typeof contract === 'object' && contract !== null &&
    typeof contract.goal === 'string' && contract.goal.length > 0 &&
    typeof contract.constraints === 'string' && contract.constraints.length > 0 &&
    typeof contract.expected_output === 'string' && contract.expected_output.length > 0 &&
    typeof contract.failure_conditions === 'string' && contract.failure_conditions.length > 0
  );
}

function findStep(steps, phase) {
  return steps.find(s => s.agent === 'review-board' && s.phase === phase);
}

// ── Test data ─────────────────────────────────────────────────────────────────

const VALID_TARGET_PROJECT = {
  organization: 'ticari',
  project: 'my-app',
  component: 'backend',
  path: '/Users/user/projects/my-app/backend',
  branch: 'feature/W-100-auth',
};

const VALID_DISPATCH_PLAN = {
  source_agent: 'findings-coordinator',
  target_project: VALID_TARGET_PROJECT,
  classification: {
    type: 'bugfix',
    complexity: 'medium',
    confidence: 0.85,
  },
  execution_plan: {
    workflow: 'investigate-then-fix',
    worktree_required: true,
    steps: [
      {
        order: 1,
        agent: 'planner',
        purpose: 'Decompose remediation into tasks',
        parallel_with: [],
        contract: {
          goal: 'Produce a task plan for fixing the N+1 query across 7 service files.',
          constraints: 'Do not change the public API surface or database schema.',
          expected_output: 'Ordered task list with parallel batches and DispatchContracts per task.',
          failure_conditions: 'Plan modifies files outside src/services/ or proposes schema migrations.',
        },
      },
      {
        order: 2,
        agent: 'review-board',
        phase: 'plan',
        board: ['tech-reviewer-swe', 'tech-reviewer-arch', 'tech-reviewer-pm', 'tech-reviewer-dx'],
        purpose: 'Plan Gate: validate approach before implementation begins',
        parallel_with: [],
      },
      {
        order: 3,
        agent: 'coder-backend',
        purpose: 'Apply query optimizations per plan',
        parallel_with: [],
        contract: {
          goal: 'Refactor service methods to eliminate N+1 queries identified in the debugger report.',
          constraints: 'Only modify files listed in the plan; no new dependencies.',
          expected_output: 'Modified service files with eager-loading or batched queries.',
          failure_conditions: 'Any public API response shape changes or new test failures introduced.',
        },
      },
      {
        order: 4,
        agent: 'tester',
        purpose: 'Verify fix with existing and new regression tests',
        parallel_with: [],
        contract: {
          goal: 'Confirm all service tests pass and add regression tests for the affected query paths.',
          constraints: 'Do not modify production code; test files only.',
          expected_output: 'Passing test suite with at least 3 new regression tests covering the fixed paths.',
          failure_conditions: 'Existing tests fail or new tests do not cover the affected query paths.',
        },
      },
      {
        order: 5,
        agent: 'review-board',
        phase: 'code',
        board: ['tech-reviewer-swe', 'tech-reviewer-arch', 'tech-reviewer-prod'],
        verify_contract: true,
        purpose: 'Code Gate: verify implementation quality and contract satisfaction',
        parallel_with: [],
      },
      {
        order: 6,
        agent: 'git-ops',
        purpose: 'Commit and push to feature branch',
        parallel_with: [],
      },
    ],
  },
  suggested_work_item: {
    title: 'Fix N+1 queries in service layer',
    priority: 'high',
    tags: ['performance', 'backend'],
    reason: 'Debugger found N+1 queries across 7 files causing >500ms latency on list endpoints.',
  },
};

const LOW_CONFIDENCE_PLAN = {
  source_agent: 'findings-coordinator',
  target_project: VALID_TARGET_PROJECT,
  classification: {
    type: 'investigation',
    complexity: 'medium',
    confidence: 0.55,
  },
  clarifications_needed: [
    'Findings reference "the auth module" but do not specify which auth flow is affected.',
    'Unclear whether the issue is in the token validation or the session persistence layer.',
  ],
  execution_plan: {
    workflow: 'investigate-then-fix',
    worktree_required: false,
    steps: [],
  },
};

const ERROR_OUTPUT = {
  error: 'target_project required',
  missing_fields: ['organization', 'branch'],
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('findings-coordinator output schema', () => {

  describe('Valid DispatchPlan (medium+ with plan-gate and code-gate)', () => {
    it('FC-1: source_agent is "findings-coordinator"', () => {
      assert.strictEqual(VALID_DISPATCH_PLAN.source_agent, 'findings-coordinator');
    });

    it('FC-2: target_project has all five required fields', () => {
      assert.ok(
        hasAllTargetProjectFields(VALID_DISPATCH_PLAN.target_project),
        'target_project must have organization, project, component, path, and branch',
      );
    });

    it('FC-3: classification has required fields', () => {
      assert.ok(
        hasRequiredClassification(VALID_DISPATCH_PLAN.classification),
        'classification must have type, complexity (valid enum), and confidence',
      );
    });

    it('FC-4: execution_plan steps include a plan-gate step', () => {
      const steps = VALID_DISPATCH_PLAN.execution_plan.steps;
      const planGate = findStep(steps, 'plan');
      assert.ok(planGate, 'steps must include a review-board step with phase "plan"');
      assert.ok(Array.isArray(planGate.board) && planGate.board.length > 0, 'plan-gate must have a non-empty board');
    });

    it('FC-5: execution_plan steps include a code-gate step', () => {
      const steps = VALID_DISPATCH_PLAN.execution_plan.steps;
      const codeGate = findStep(steps, 'code');
      assert.ok(codeGate, 'steps must include a review-board step with phase "code"');
      assert.ok(codeGate.verify_contract === true, 'code-gate must have verify_contract: true');
    });

    it('FC-6: plan-gate precedes all coder-* steps', () => {
      const steps = VALID_DISPATCH_PLAN.execution_plan.steps;
      const planGateOrder = findStep(steps, 'plan').order;
      const coderSteps = steps.filter(s => s.agent.startsWith('coder'));
      for (const s of coderSteps) {
        assert.ok(planGateOrder < s.order, `plan-gate (order ${planGateOrder}) must precede coder step (order ${s.order})`);
      }
    });

    it('FC-7: medium+ steps include contracts', () => {
      const steps = VALID_DISPATCH_PLAN.execution_plan.steps;
      const implementationSteps = steps.filter(s => s.agent !== 'review-board' && s.agent !== 'git-ops');
      for (const s of implementationSteps) {
        assert.ok(
          hasValidContract(s.contract),
          `step ${s.order} (${s.agent}) must have a valid contract with all four core fields`,
        );
      }
    });

    it('FC-8: suggested_work_item is present for medium+', () => {
      assert.ok(
        typeof VALID_DISPATCH_PLAN.suggested_work_item === 'object' &&
        VALID_DISPATCH_PLAN.suggested_work_item !== null &&
        typeof VALID_DISPATCH_PLAN.suggested_work_item.title === 'string',
        'suggested_work_item must be present for medium+ complexity',
      );
    });

    it('FC-9: all steps have parallel_with evaluated (array, not undefined)', () => {
      const steps = VALID_DISPATCH_PLAN.execution_plan.steps;
      for (const s of steps) {
        assert.ok(
          Array.isArray(s.parallel_with),
          `step ${s.order} (${s.agent}) must have parallel_with as an array`,
        );
      }
    });
  });

  describe('Low-confidence output (clarifications_needed, no steps)', () => {
    it('FC-10: source_agent is "findings-coordinator"', () => {
      assert.strictEqual(LOW_CONFIDENCE_PLAN.source_agent, 'findings-coordinator');
    });

    it('FC-11: clarifications_needed is non-empty', () => {
      assert.ok(
        Array.isArray(LOW_CONFIDENCE_PLAN.clarifications_needed) &&
        LOW_CONFIDENCE_PLAN.clarifications_needed.length > 0,
        'clarifications_needed must be a non-empty array on the confidence floor path',
      );
    });

    it('FC-12: steps array is empty when clarifications block planning', () => {
      assert.strictEqual(
        LOW_CONFIDENCE_PLAN.execution_plan.steps.length,
        0,
        'steps must be empty when confidence floor triggers clarifications_needed',
      );
    });

    it('FC-13: target_project still has all five fields', () => {
      assert.ok(
        hasAllTargetProjectFields(LOW_CONFIDENCE_PLAN.target_project),
        'target_project must be fully populated even on the clarifications path',
      );
    });
  });

  describe('Error output (missing target_project context)', () => {
    it('FC-14: error field is "target_project required"', () => {
      assert.strictEqual(ERROR_OUTPUT.error, 'target_project required');
    });

    it('FC-15: missing_fields is a non-empty array of strings', () => {
      assert.ok(
        Array.isArray(ERROR_OUTPUT.missing_fields) &&
        ERROR_OUTPUT.missing_fields.length > 0 &&
        ERROR_OUTPUT.missing_fields.every(f => typeof f === 'string'),
        'missing_fields must be a non-empty string array',
      );
    });

    it('FC-16: error output does not contain execution_plan or source_agent', () => {
      assert.strictEqual(ERROR_OUTPUT.execution_plan, undefined);
      assert.strictEqual(ERROR_OUTPUT.source_agent, undefined);
    });
  });

});
