import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import claudeAdapter from '../adapters/claude.mjs';

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
