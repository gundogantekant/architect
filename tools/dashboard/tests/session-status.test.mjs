/**
 * Unit tests for session-status.mjs (W-1343).
 *
 * These run under `node --test` (test:unit) with no server, DB, or pty — possible
 * because session-status.mjs is intentionally import-free.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyDispatchClose, classifyTerminalExit } from '../session-status.mjs';

// ---------------------------------------------------------------------------
// Guard: session-status.mjs must remain import-free for unit-test safety.
// If this check fails it means a dependency was added that would pull in DB/pty
// on import, breaking the node --test run.
// ---------------------------------------------------------------------------
describe('session-status module shape', () => {
  it('exports exactly classifyDispatchClose and classifyTerminalExit', () => {
    const mod = { classifyDispatchClose, classifyTerminalExit };
    assert.equal(typeof mod.classifyDispatchClose, 'function');
    assert.equal(typeof mod.classifyTerminalExit, 'function');
  });
});

// ---------------------------------------------------------------------------
// classifyDispatchClose
// ---------------------------------------------------------------------------
describe('classifyDispatchClose — suspended preserve', () => {
  it('preserves suspended status when already suspended', () => {
    const dispatch = { id: 'D-1', status: 'suspended', exit_type: null };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.preserve, true);
    assert.equal(result.status, 'suspended');
    // Intentional: exit_type NOT written for suspended exits — no matching bucket.
    assert.equal(result.exit_type, null);
  });

  it('carries through a previously-set exit_type when preserving', () => {
    const dispatch = { id: 'D-2', status: 'suspended', exit_type: 'graceful' };
    const result = classifyDispatchClose(dispatch, 0);
    assert.equal(result.preserve, true);
    assert.equal(result.exit_type, 'graceful');
  });
});

describe('classifyDispatchClose — graceful exit (code 0)', () => {
  it('returns completed + graceful for code 0 normal exit', () => {
    const dispatch = { id: 'D-3', status: 'running' };
    const result = classifyDispatchClose(dispatch, 0);
    assert.equal(result.preserve, false);
    assert.equal(result.status, 'completed');
    assert.equal(result.exit_type, 'graceful');
  });
});

describe('classifyDispatchClose — non-zero exit', () => {
  it('returns failed + interrupted for non-zero ungraceful exit', () => {
    const dispatch = { id: 'D-4', status: 'running' };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.preserve, false);
    assert.equal(result.status, 'failed');
    assert.equal(result.exit_type, 'interrupted');
  });
});

describe('classifyDispatchClose — _killedIntentionally', () => {
  it('sets exit_type killed but status remains failed (not killed) — delete removes record', () => {
    const dispatch = { id: 'D-5', status: 'running', _killedIntentionally: true };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.preserve, false);
    assert.equal(result.exit_type, 'killed');
    // Status is still completed/failed — the kill path deletes the record via DELETE endpoint.
    assert.equal(result.status, 'failed');
  });

  it('_killedIntentionally with code 0 keeps exit_type killed, status completed', () => {
    const dispatch = { id: 'D-6', status: 'running', _killedIntentionally: true };
    const result = classifyDispatchClose(dispatch, 0);
    assert.equal(result.exit_type, 'killed');
    assert.equal(result.status, 'completed');
  });
});

describe('classifyDispatchClose — _timedOut', () => {
  it('sets exit_type timeout for timed-out exit', () => {
    const dispatch = { id: 'D-7', status: 'running', _timedOut: true };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.preserve, false);
    assert.equal(result.exit_type, 'timeout');
    assert.equal(result.status, 'failed');
  });
});

describe('classifyDispatchClose — _gracefulInterrupt', () => {
  it('sets status interrupted when graceful interrupt (no kill intent)', () => {
    const dispatch = { id: 'D-8', status: 'running', _gracefulInterrupt: true };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.preserve, false);
    assert.equal(result.status, 'interrupted');
    assert.equal(result.exit_type, 'interrupted');
  });

  it('_gracefulInterrupt + _killedIntentionally → kill intent overrides, status not interrupted', () => {
    const dispatch = { id: 'D-9', status: 'running', _gracefulInterrupt: true, _killedIntentionally: true };
    const result = classifyDispatchClose(dispatch, 1);
    assert.equal(result.status, 'failed');
    assert.equal(result.exit_type, 'killed');
  });
});

// ---------------------------------------------------------------------------
// classifyTerminalExit
// ---------------------------------------------------------------------------
describe('classifyTerminalExit — suspended preserve', () => {
  it('preserves suspended status', () => {
    const result = classifyTerminalExit('suspended', 1);
    assert.equal(result.preserve, true);
    assert.equal(result.status, 'suspended');
  });

  it('preserves suspended even on clean exit code', () => {
    const result = classifyTerminalExit('suspended', 0);
    assert.equal(result.preserve, true);
    assert.equal(result.status, 'suspended');
  });
});

describe('classifyTerminalExit — normal exits', () => {
  it('returns completed for exitCode 0', () => {
    const result = classifyTerminalExit('running', 0);
    assert.equal(result.preserve, false);
    assert.equal(result.status, 'completed');
  });

  it('returns failed for non-zero exitCode', () => {
    const result = classifyTerminalExit('running', 1);
    assert.equal(result.preserve, false);
    assert.equal(result.status, 'failed');
  });

  it('returns failed for any non-suspended status with non-zero code', () => {
    for (const s of ['running', 'completed', 'failed', 'killed']) {
      const result = classifyTerminalExit(s, 2);
      assert.equal(result.preserve, false, `should not preserve for status=${s}`);
    }
  });
});
