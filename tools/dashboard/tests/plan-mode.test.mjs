import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import claudeAdapter from '../adapters/claude.mjs';
import { buildPermissionArgs } from '../permission-args.mjs';

const { buildDispatchPrompt } = await import('../prompt-builder.mjs');

/**
 * Plan Mode Unit Tests
 *
 * PM-1: CLI flag passed when plan mode selected
 * PM-2: Readiness waits for bracketed paste enable
 * PM-3: Readiness fires on bracketed paste enable
 * PM-5: Plan badge data available from adapter
 * PM-6: Adapter injection delay
 */

describe('PM-1: CLI flag passed when plan mode selected', () => {
  it('includes --permission-mode plan in args', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'plan' });
    const idx = args.indexOf('--permission-mode');
    assert.ok(idx >= 0, 'must include --permission-mode flag');
    assert.equal(args[idx + 1], 'plan');
  });

  it('includes --permission-mode acceptEdits when not plan', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'acceptEdits' });
    const idx = args.indexOf('--permission-mode');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'acceptEdits');
  });

  it('throws when no permissionMode provided (throw-on-unknown contract, not silent coerce)', () => {
    // Per plan Success #5 + domain/rules.md → Permission Mode Rules, buildPermissionArgs throws
    // on an unrecognized mode rather than coercing to acceptEdits. Every production caller
    // resolves an explicit mode before reaching here, so this only fires on a routing bug.
    assert.throws(
      () => claudeAdapter.buildArgs('session-123', {}),
      /unsupported permissionMode/,
    );
  });

  it('does NOT include --dangerously-skip-permissions in plan mode even when skip requested (plan supersedes skip)', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'plan', skipPermissions: true });
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'plan mode must never emit skip-permissions');
  });

  it('does not include --dangerously-skip-permissions when not requested', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'plan', skipPermissions: false });
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('includes --dangerously-skip-permissions in acceptEdits mode when skip requested', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'acceptEdits', skipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });
});

describe('buildPermissionArgs: plan supersedes skip-permissions', () => {
  it('plan + skip:true → plan flag, no skip-permissions', () => {
    const args = buildPermissionArgs({ permissionMode: 'plan', skipPermissions: true });
    assert.deepEqual(args, ['--permission-mode', 'plan']);
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('acceptEdits + skip:true → both flags', () => {
    const args = buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: true });
    assert.deepEqual(args, ['--permission-mode', 'acceptEdits', '--dangerously-skip-permissions']);
  });

  it('plan + skip:false → plan flag only', () => {
    const args = buildPermissionArgs({ permissionMode: 'plan', skipPermissions: false });
    assert.deepEqual(args, ['--permission-mode', 'plan']);
  });

  it('undefined mode throws (throw-on-unknown replaces the old coerce-to-acceptEdits)', () => {
    assert.throws(
      () => buildPermissionArgs({ skipPermissions: false }),
      /unsupported permissionMode/,
    );
  });
});

function basePromptArgs(overrides = {}) {
  return {
    workItem: null,
    projectKey: 'org/proj/main',
    projectPath: '/projects/proj',
    additionalInstructions: null,
    portfolio: null,
    epicContext: null,
    orgContext: null,
    relatedProjects: null,
    worktreeContext: null,
    contract: null,
    ...overrides,
  };
}

describe('buildDispatchPrompt: plan-only mode', () => {
  it('planMode:true injects # Plan-Only Mode with directive MUSTs', () => {
    const prompt = buildDispatchPrompt(basePromptArgs({ planMode: true }));
    assert.ok(prompt.includes('# Plan-Only Mode'), 'must contain Plan-Only Mode section');
    assert.ok(prompt.includes('NOT modify'), 'must contain NOT modify directive');
    assert.ok(prompt.includes('NOT commit'), 'must contain NOT commit directive');
  });

  it('planMode:true places Plan-Only Mode BEFORE the SDLC Guide', () => {
    const prompt = buildDispatchPrompt(basePromptArgs({ planMode: true }));
    const planIdx = prompt.indexOf('# Plan-Only Mode');
    const sdlcIdx = prompt.indexOf('# SDLC Guide');
    assert.ok(planIdx >= 0 && sdlcIdx >= 0, 'both sections present');
    assert.ok(planIdx < sdlcIdx, 'Plan-Only Mode must appear before SDLC Guide');
  });

  it('planMode:false (default) omits the Plan-Only Mode section', () => {
    const prompt = buildDispatchPrompt(basePromptArgs());
    assert.ok(!prompt.includes('# Plan-Only Mode'), 'default must not inject Plan-Only Mode');
  });
});

describe('resume arg-builder regression: plan + skip → no skip flag', () => {
  it('resume args built via buildPermissionArgs suppress skip in plan mode', () => {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
      '--resume', 'sess-abc',
      ...buildPermissionArgs({ permissionMode: 'plan', skipPermissions: true }),
    ];
    assert.ok(args.includes('--permission-mode'));
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
    assert.ok(!args.includes('--dangerously-skip-permissions'), 'resume in plan mode must not emit skip-permissions');
  });
});

describe('PM-2: Readiness waits for bracketed paste enable', () => {
  it('returns false on first byte of output (no bracketed paste yet)', () => {
    const result = claudeAdapter.detectReadiness('', 'x');
    assert.equal(result, false, 'must not fire readiness on first byte');
  });

  it('returns false when only alternate screen is present, no bracketed paste', () => {
    const accumulated = 'Some initial output \x1b[?1049h entering alt screen';
    const chunk = 'more output without bracketed paste sequence';
    const result = claudeAdapter.detectReadiness(accumulated, chunk);
    assert.equal(result, false, 'must not fire on \\x1b[?1049h alone — bracketed paste not yet active');
  });
});

describe('PM-3: Readiness fires on bracketed paste enable', () => {
  it('returns true when chunk contains bracketed paste sequence', () => {
    const result = claudeAdapter.detectReadiness('', '\x1b[?2004h');
    assert.equal(result, true, 'must fire when bracketed paste sequence is in chunk');
  });

  it('returns true when accumulated contains bracketed paste sequence', () => {
    const accumulated = 'startup output \x1b[?1049h render \x1b[?2004h more';
    const result = claudeAdapter.detectReadiness(accumulated, 'new chunk');
    assert.equal(result, true, 'must fire when bracketed paste is in accumulated');
  });

  it('returns true when bracketed paste is split across accumulated and chunk', () => {
    const accumulated = 'output \x1b[?200';
    const chunk = '4h more data';
    const result = claudeAdapter.detectReadiness(accumulated, chunk);
    assert.equal(result, true, 'must detect bracketed paste split across boundaries');
  });

  it('returns false on alternate screen sequence alone (regression guard)', () => {
    const result = claudeAdapter.detectReadiness('', '\x1b[?1049h');
    assert.equal(result, false, 'must not regress to firing on alternate screen entry alone');
  });
});

describe('PM-6: Adapter injection delay', () => {
  it('exposes injectionDelay as a non-negative number', () => {
    assert.equal(typeof claudeAdapter.injectionDelay, 'number', 'injectionDelay must be a number');
    assert.ok(claudeAdapter.injectionDelay >= 0, 'injectionDelay must be non-negative');
  });

  it('injectionDelay is at least 200ms to allow Ink event loop to settle', () => {
    assert.ok(claudeAdapter.injectionDelay >= 200, 'delay must be ≥200ms for Ink initialization');
  });
});
