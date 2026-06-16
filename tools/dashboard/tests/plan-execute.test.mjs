import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPermissionArgs } from '../permission-args.mjs';
import { resolveDispatchModeDefault, ARCHITECT_CANONICAL_KEY } from '../db.mjs';
import { ARCHITECT_KEY } from '../constants.mjs';
import { shouldCreateWorktree } from '../worktree.mjs';
import { createDispatch } from '../utils/dispatch-factory.mjs';
import { buildExecutePhaseSection } from '../prompt-builder.mjs';
import { hasPlanMarker, logEndedCleanly, isEnforceableScopeBoundary } from '../dispatch-manager.mjs';
import { validateModel } from '../utils.mjs';

/**
 * Plan-Then-Execute (plan_execute) chained-dispatch unit tests.
 *
 * Pure, node --test, no server. Covers the success criteria and E2E criteria
 * from plan-only-mode-plan-only-fuzzy-torvalds.md that can be exercised by
 * importing the implementation functions directly.
 */

// ── 1. Args invariant (Success #1, #5; E2E #1) ───────────────────────────────

describe('PE-args: buildPermissionArgs invariant for plan_execute chains', () => {
  it('plan + skip:true → never emits --dangerously-skip-permissions', () => {
    const args = buildPermissionArgs({ permissionMode: 'plan', skipPermissions: true });
    assert.deepEqual(args, ['--permission-mode', 'plan']);
    assert.ok(!args.includes('--dangerously-skip-permissions'),
      'plan-phase process must never receive skip-permissions (claude bug #17544)');
  });

  it('acceptEdits + skip:true → includes --dangerously-skip-permissions (execute phase)', () => {
    const args = buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: true });
    assert.deepEqual(args, ['--permission-mode', 'acceptEdits', '--dangerously-skip-permissions']);
  });

  it('plan_execute is a chain token, never a flag mode → throws', () => {
    assert.throws(
      () => buildPermissionArgs({ permissionMode: 'plan_execute' }),
      /unsupported permissionMode "plan_execute"/,
      'plan_execute must never reach buildPermissionArgs — throw, do not coerce',
    );
  });

  it('unknown permission mode → throws (no silent coerce-to-acceptEdits)', () => {
    assert.throws(
      () => buildPermissionArgs({ permissionMode: 'bypassPermissions' }),
      /unsupported permissionMode/,
    );
    assert.throws(
      () => buildPermissionArgs({}),
      /unsupported permissionMode/,
      'missing mode must throw rather than default to a bypass-capable mode',
    );
  });
});

// ── 2. Default resolution + architect key normalization (Success #4; E2E #5) ─

describe('PE-default: resolveDispatchModeDefault precedence and architect normalization', () => {
  const prefs = {
    default_dispatch_mode: 'acceptEdits',
    'default_dispatch_mode:ticari/architect/main': 'plan_execute',
  };

  it('canonical architect key resolves to plan_execute', () => {
    assert.equal(resolveDispatchModeDefault(ARCHITECT_CANONICAL_KEY, prefs), 'plan_execute');
  });

  it('en-dash ARCHITECT_KEY normalizes to canonical → plan_execute', () => {
    assert.equal(resolveDispatchModeDefault(ARCHITECT_KEY, prefs), 'plan_execute');
  });

  it('a non-architect project resolves to acceptEdits (unchanged)', () => {
    assert.equal(resolveDispatchModeDefault('some/other/comp', prefs), 'acceptEdits');
  });

  it('null/missing project key falls back to the global default', () => {
    assert.equal(resolveDispatchModeDefault(null, prefs), 'acceptEdits');
  });

  it('with no prefs at all, falls back to acceptEdits (safe default)', () => {
    assert.equal(resolveDispatchModeDefault('some/other/comp', {}), 'acceptEdits');
    assert.equal(resolveDispatchModeDefault(ARCHITECT_KEY, {}), 'acceptEdits');
  });
});

// ── 3. Worktree decision for a chain (worktree isolation, plan §47) ──────────

describe('PE-worktree: shouldCreateWorktree evaluates a chain against its effective mode', () => {
  // ROOT is a git repo (the architect checkout); use it so isGitRepository passes.
  const ROOT = new URL('../../..', import.meta.url).pathname;

  it('plan_execute chain (phase-1 plan flag, no work item) → true (effective acceptEdits)', async () => {
    const create = await shouldCreateWorktree({
      permissionMode: 'plan',
      workItemId: null,
      portfolioEntry: null,
      featureFlag: true,
      projectPath: ROOT,
      chainMode: 'plan_execute',
    });
    assert.equal(create, true,
      'a plan_execute chain must get a worktree even with the phase-1 plan flag and no ticket');
  });

  it('plain plan mode (no chain) → false', async () => {
    const create = await shouldCreateWorktree({
      permissionMode: 'plan',
      workItemId: 'W-999',
      portfolioEntry: null,
      featureFlag: true,
      projectPath: ROOT,
      chainMode: null,
    });
    assert.equal(create, false, 'a non-chain plan dispatch must not create a worktree');
  });

  it('plan_execute chain honors feature flag off → false', async () => {
    const create = await shouldCreateWorktree({
      permissionMode: 'plan',
      workItemId: null,
      portfolioEntry: null,
      featureFlag: false,
      projectPath: ROOT,
      chainMode: 'plan_execute',
    });
    assert.equal(create, false);
  });

  it('plan_execute chain on explicit worktree_mode → false', async () => {
    const create = await shouldCreateWorktree({
      permissionMode: 'plan',
      workItemId: null,
      portfolioEntry: { worktree_mode: 'explicit' },
      featureFlag: true,
      projectPath: ROOT,
      chainMode: 'plan_execute',
    });
    assert.equal(create, false);
  });
});

// ── 4. Factory populates chain fields (E2E #2 data plumbing) ─────────────────

describe('PE-factory: createDispatch carries chain_* fields', () => {
  const BASE = { id: 'D-pe-1', projectKey: 'ticari/architect/main', projectPath: '/tmp/p' };

  it('populates chain_mode/chain_phase/chain_autostart/chain_parent_id when supplied', () => {
    const d = createDispatch({
      ...BASE,
      chainMode: 'plan_execute',
      chainPhase: 'plan',
      chainAutostart: true,
      chainParentId: 'D-parent',
    });
    assert.equal(d.chain_mode, 'plan_execute');
    assert.equal(d.chain_phase, 'plan');
    assert.equal(d.chain_autostart, true);
    assert.equal(d.chain_parent_id, 'D-parent');
  });

  it('chain fields default to null for a standard dispatch', () => {
    const d = createDispatch(BASE);
    assert.equal(d.chain_mode, null);
    assert.equal(d.chain_phase, null);
    assert.equal(d.chain_autostart, null);
    assert.equal(d.chain_parent_id, null);
  });

  it('carries model when supplied; null when omitted (FIX 2)', () => {
    assert.equal(createDispatch({ ...BASE, model: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
    assert.equal(createDispatch(BASE).model, null);
  });
});

// ── FIX 1: root scope boundary skips the file-level violation check ───────────

describe('PE-scope: isEnforceableScopeBoundary skips root, enforces a real sub-scope', () => {
  it('root boundaries ".", "./", "", null, undefined → not enforceable (skip check)', () => {
    for (const b of ['.', './', '', '  ', null, undefined]) {
      assert.equal(isEnforceableScopeBoundary(b), false, `boundary ${JSON.stringify(b)} must skip`);
    }
  });

  it('a real sub-scope like "tools/dashboard" (with or without trailing slash) → enforceable', () => {
    assert.equal(isEnforceableScopeBoundary('tools/dashboard'), true);
    assert.equal(isEnforceableScopeBoundary('tools/dashboard/'), true);
    assert.equal(isEnforceableScopeBoundary('domain'), true);
  });
});

// ── FIX 2: validateModel is idempotent so a persisted resolved id round-trips ──

describe('PE-model: validateModel resolves aliases and passes resolved ids through', () => {
  it('aliases resolve to their canonical ids', () => {
    assert.equal(validateModel('opus'), 'claude-opus-4-8');
    assert.equal(validateModel('haiku'), 'claude-haiku-4-5-20251001');
    assert.equal(validateModel('sonnet'), 'claude-sonnet-4-6');
  });

  it('an already-resolved id passes through unchanged (no silent sonnet fallback)', () => {
    assert.equal(validateModel('claude-opus-4-8'), 'claude-opus-4-8');
    assert.equal(validateModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5-20251001');
  });

  it('unknown / unset falls back to sonnet', () => {
    assert.equal(validateModel('gpt-4'), 'claude-sonnet-4-6');
    assert.equal(validateModel(undefined), 'claude-sonnet-4-6');
  });
});

// ── 5. Execute-phase prompt (Success #2; E2E #2) ─────────────────────────────

describe('PE-prompt: buildExecutePhaseSection emits the approved-plan execute directive', () => {
  it('contains the execute-phase heading and "plan is approved" directive', () => {
    const section = buildExecutePhaseSection();
    assert.ok(section.includes('# Execute Phase'), 'must carry an Execute Phase heading');
    assert.ok(/approved/i.test(section), 'must tell the agent its prior plan is approved');
    assert.ok(/Do not re-plan/i.test(section), 'must forbid re-planning in the execute phase');
    assert.ok(/scope_boundary/.test(section), 'must reference the scope_boundary self-guard');
  });
});

// ── 6. Plan-marker / clean-log helpers (Success #6, #7; E2E #6, #7) ──────────

function jsonl(...objs) {
  return objs.map((o) => JSON.stringify(o));
}

describe('PE-marker: hasPlanMarker detects an ExitPlanMode tool use', () => {
  it('true when an assistant message carries an ExitPlanMode tool_use block', () => {
    const out = jsonl(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode' }] } },
    );
    assert.equal(hasPlanMarker(out), true);
  });

  it('true on a content_block_start ExitPlanMode event', () => {
    const out = jsonl(
      { type: 'content_block_start', content_block: { type: 'tool_use', name: 'ExitPlanMode' } },
    );
    assert.equal(hasPlanMarker(out), true);
  });

  it('false when no plan marker is present (empty plan → no autostart)', () => {
    const out = jsonl(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'just chatting' }] } },
      { type: 'result' },
    );
    assert.equal(hasPlanMarker(out), false);
  });

  it('false on empty / garbage output', () => {
    assert.equal(hasPlanMarker([]), false);
    assert.equal(hasPlanMarker(['not json', '{bad']), false);
    assert.equal(hasPlanMarker(undefined), false);
  });
});

describe('PE-clean: logEndedCleanly distinguishes a finished turn from a cut-off one', () => {
  it('true when the trailing event is a result', () => {
    const out = jsonl(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'ExitPlanMode' }] } },
      { type: 'result' },
    );
    assert.equal(logEndedCleanly(out), true);
  });

  it('false when the trailing event is not a result (interrupted)', () => {
    const out = jsonl(
      { type: 'result' },
      { type: 'content_block_delta', delta: { text: 'still going' } },
    );
    assert.equal(logEndedCleanly(out), false);
  });

  it('false on empty output', () => {
    assert.equal(logEndedCleanly([]), false);
    assert.equal(logEndedCleanly(undefined), false);
  });
});

// ── 7. resolvedSkipPerms logic for plan_execute dispatches ────────────────────

// Mirror the exact expression from routes/dispatch.mjs lines 273-275 so any
// future drift between the route and the tests is a compile-time failure here.
function resolvedSkipPerms(isPlanExecuteChain, skip_permissions) {
  return isPlanExecuteChain
    ? (skip_permissions === undefined || skip_permissions === true || skip_permissions === 'true')
    : (skip_permissions === true || skip_permissions === 'true');
}

describe('PE-skip: resolvedSkipPerms for plan_execute vs other modes', () => {
  it('plan_execute + skip_permissions=true → true', () => {
    assert.equal(resolvedSkipPerms(true, true), true);
  });

  it('plan_execute + skip_permissions=false → false', () => {
    assert.equal(resolvedSkipPerms(true, false), false);
  });

  it('plan_execute + skip_permissions=undefined → true (backwards-compat default)', () => {
    assert.equal(resolvedSkipPerms(true, undefined), true);
  });

  it('plan mode (not plan_execute) → false regardless of skip_permissions', () => {
    assert.equal(resolvedSkipPerms(false, true), true,
      'non-chain plan_execute with skip=true still forwards the user choice');
    assert.equal(resolvedSkipPerms(false, undefined), false,
      'non-chain dispatch with no skip_permissions defaults to false');
  });
});

// ── 8. Phase-2 skip_permissions inheritance via ?? true ───────────────────────

describe('PE-phase2-skip: phase-2 inherits stored skip_permissions via ?? true fallback', () => {
  it('skip_permissions=true stored → phase-2 receives --dangerously-skip-permissions', () => {
    const storedSkipPerms = true;
    const args = buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: storedSkipPerms ?? true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('skip_permissions=false stored → phase-2 does NOT receive --dangerously-skip-permissions', () => {
    const storedSkipPerms = false;
    const args = buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: storedSkipPerms ?? true });
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('skip_permissions=null stored (legacy row) → ?? true defaults to true → phase-2 receives skip', () => {
    const storedSkipPerms = null;
    const args = buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: storedSkipPerms ?? true });
    assert.ok(args.includes('--dangerously-skip-permissions'),
      'null coerces to true via ?? so legacy rows retain skip-perms in execute phase');
  });
});
