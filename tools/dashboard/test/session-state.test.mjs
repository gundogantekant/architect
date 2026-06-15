import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sessionNeedsInput,
  newlyNeedingInput,
  notificationDecision,
} from '../js/session-state.mjs';

// ---------------------------------------------------------------------------
// sessionNeedsInput — table-driven
// ---------------------------------------------------------------------------

test('sessionNeedsInput: true cases (execute_pending, work_item_input_needed, waiting+running)', () => {
  const trueCases = [
    ['status execute_pending', { status: 'execute_pending' }],
    ['work_item_input_needed flag', { work_item_input_needed: true }],
    ['agent_phase waiting_for_input while running', { agent_phase: 'waiting_for_input', status: 'running' }],
  ];
  for (const [label, session] of trueCases) {
    assert.equal(sessionNeedsInput(session), true, `${label} must need input`);
  }
});

test('sessionNeedsInput: false cases (not running, plain statuses, terminal/cli, nullish)', () => {
  const falseCases = [
    ['waiting_for_input but completed (not running)', { agent_phase: 'waiting_for_input', status: 'completed' }],
    ['plain running', { status: 'running' }],
    ['plain completed', { status: 'completed' }],
    ['terminal excluded despite input flag', { type: 'terminal', work_item_input_needed: true }],
    ['cli excluded despite execute_pending', { type: 'cli', status: 'execute_pending' }],
    ['null', null],
    ['undefined', undefined],
  ];
  for (const [label, session] of falseCases) {
    assert.equal(sessionNeedsInput(session), false, `${label} must not need input`);
  }
});

// ---------------------------------------------------------------------------
// newlyNeedingInput — false→true transition detection, deduped via a Set
// ---------------------------------------------------------------------------

test('newlyNeedingInput: reports ids needing input now but absent from prevSet', () => {
  const sessions = [
    { id: 'D-1', status: 'execute_pending' },
    { id: 'D-2', agent_phase: 'waiting_for_input', status: 'running' },
    { id: 'D-3', status: 'running' }, // not needing
  ];
  const prevSet = new Set(['D-1']); // D-1 already alerted
  assert.deepEqual(newlyNeedingInput(prevSet, sessions), ['D-2']);
});

test('newlyNeedingInput: returns [] when all currently-needing ids are already in prevSet', () => {
  const sessions = [
    { id: 'D-1', status: 'execute_pending' },
    { id: 'D-2', agent_phase: 'waiting_for_input', status: 'running' },
  ];
  const prevSet = new Set(['D-1', 'D-2']);
  assert.deepEqual(newlyNeedingInput(prevSet, sessions), []);
  // Stable across repeated calls with the same set — no duplicate alerts.
  assert.deepEqual(newlyNeedingInput(prevSet, sessions), []);
});

test('newlyNeedingInput: a session that left and re-entered is reported again', () => {
  const set = new Set();
  const needing = [{ id: 'D-9', agent_phase: 'waiting_for_input', status: 'running' }];

  // First time needing — not in set → reported.
  assert.deepEqual(newlyNeedingInput(set, needing), ['D-9']);
  // Caller records the alert.
  set.add('D-9');
  // Still needing, already in set → not reported again.
  assert.deepEqual(newlyNeedingInput(set, needing), []);

  // Session resumes (no longer needing). Caller prunes the set to currently-needing ids.
  set.delete('D-9');
  assert.deepEqual(newlyNeedingInput(set, []), []);

  // Session re-enters waiting — pruned from set → reported again.
  assert.deepEqual(newlyNeedingInput(set, needing), ['D-9']);
});

test('newlyNeedingInput: baseline seeding on first load yields no alerts', () => {
  const sessions = [
    { id: 'D-1', status: 'execute_pending' },
    { id: 'D-2', agent_phase: 'waiting_for_input', status: 'running' },
    { id: 'D-3', status: 'running' },
  ];
  // Seed a fresh Set from the ids needing input on first load (baseline).
  const baseline = new Set(sessions.filter(sessionNeedsInput).map(s => s.id));
  // Calling with that same baseline must not alert for already-waiting sessions.
  assert.deepEqual(newlyNeedingInput(baseline, sessions), []);
});

// ---------------------------------------------------------------------------
// notificationDecision — default-ON, permission gated
// ---------------------------------------------------------------------------

test('notificationDecision: empty prefs + granted → both on (default ON)', () => {
  assert.deepEqual(notificationDecision({}, 'granted'), { os: true, sound: true });
});

test('notificationDecision: notify_input_os=false disables OS only', () => {
  assert.deepEqual(notificationDecision({ notify_input_os: 'false' }, 'granted'), { os: false, sound: true });
});

test('notificationDecision: notify_input_sound=false disables sound only', () => {
  assert.deepEqual(notificationDecision({ notify_input_sound: 'false' }, 'granted'), { os: true, sound: false });
});

test('notificationDecision: OS is off unless permission is granted', () => {
  assert.equal(notificationDecision({}, 'denied').os, false);
  assert.equal(notificationDecision({}, 'default').os, false);
  // Sound is independent of OS notification permission.
  assert.equal(notificationDecision({}, 'denied').sound, true);
});
