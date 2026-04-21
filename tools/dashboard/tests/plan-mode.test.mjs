import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import claudeAdapter from '../adapters/claude.mjs';

/**
 * Plan Mode Unit Tests
 *
 * PM-1: CLI flag passed when plan mode selected
 * PM-2: Readiness waits for alternate screen entry
 * PM-3: Readiness fires on alternate screen entry
 * PM-5: Plan badge data available from adapter
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

  it('defaults to acceptEdits when no permissionMode provided', () => {
    const args = claudeAdapter.buildArgs('session-123', {});
    const idx = args.indexOf('--permission-mode');
    assert.ok(idx >= 0);
    assert.equal(args[idx + 1], 'acceptEdits');
  });

  it('includes --dangerously-skip-permissions when requested', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'plan', skipPermissions: true });
    assert.ok(args.includes('--dangerously-skip-permissions'));
  });

  it('does not include --dangerously-skip-permissions when not requested', () => {
    const args = claudeAdapter.buildArgs('session-123', { permissionMode: 'plan', skipPermissions: false });
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });
});

describe('PM-2: Readiness waits for alternate screen entry', () => {
  it('returns false on first byte of output (no alt screen yet)', () => {
    const result = claudeAdapter.detectReadiness('', 'x');
    // After the fix, this should return false (waiting for \x1b[?1049h)
    // Before the fix, this returns true (any chunk.length > 0)
    // This test documents the EXPECTED behavior after the fix
    assert.equal(result, false, 'must not fire readiness on first byte');
  });

  it('returns false on accumulated output without alt screen sequence', () => {
    const accumulated = 'Some initial output from Claude CLI startup...';
    const chunk = 'more output data';
    const result = claudeAdapter.detectReadiness(accumulated, chunk);
    assert.equal(result, false, 'must not fire without \\x1b[?1049h');
  });
});

describe('PM-3: Readiness fires on alternate screen entry', () => {
  it('returns true when chunk contains alt screen sequence', () => {
    const result = claudeAdapter.detectReadiness('', '\x1b[?1049h');
    assert.equal(result, true, 'must fire on alt screen entry');
  });

  it('returns true when accumulated contains alt screen sequence', () => {
    const accumulated = 'startup output \x1b[?1049h more output';
    const result = claudeAdapter.detectReadiness(accumulated, 'new chunk');
    assert.equal(result, true, 'must fire when accumulated has alt screen');
  });

  it('returns true when alt screen is split across accumulated and chunk', () => {
    const accumulated = 'output \x1b[?104';
    const chunk = '9h more data';
    const result = claudeAdapter.detectReadiness(accumulated, chunk);
    assert.equal(result, true, 'must detect alt screen split across boundaries');
  });
});
