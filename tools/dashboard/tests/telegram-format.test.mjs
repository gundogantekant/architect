/**
 * Unit tests for the pure Telegram bridge formatter and target resolver.
 *
 * Imports only format.mjs (pure, no I/O, no node_modules), so this suite runs
 * standalone with `node --test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNotification,
  resolveTarget,
  deliveredMsg,
  busyMsg,
  exitedMsg,
  unresolvedMsg,
  sessionsListMsg,
  failureMsg,
  buildQuestionNotification,
  confirmMsg,
  cancelledMsg,
  expiredMsg,
  selectedMsg,
  staleScreenMsg,
} from '../telegram/format.mjs';

function terminal(overrides = {}) {
  return {
    id: 'T-abc',
    status: 'running',
    project_key: 'ticari/architect/main',
    work_item_id: undefined,
    isWaiting: false,
    questionText: '',
    ...overrides,
  };
}

function update(message) {
  return { message };
}

test('buildNotification: question kind keeps body verbatim, no work item', () => {
  const out = buildNotification(terminal(), 'question', 'Proceed?');
  assert.equal(out, '🔔 T-abc · ticari/architect/main\n\nProceed?');
});

test('buildNotification: includes work_item_id in header when present', () => {
  const out = buildNotification(terminal({ work_item_id: 'W-1' }), 'question', 'Proceed?');
  assert.equal(out, '🔔 T-abc · ticari/architect/main · W-1\n\nProceed?');
});

test('buildNotification: missing project_key falls back to unknown', () => {
  const out = buildNotification(terminal({ project_key: undefined }), 'question', 'Hi');
  assert.equal(out, '🔔 T-abc · unknown\n\nHi');
});

test('buildNotification: lifecycle kind wraps body with exit prefix', () => {
  const out = buildNotification(terminal(), 'lifecycle', 'code 0');
  assert.equal(out, '🔔 T-abc · ticari/architect/main\n\nTerminal exited: code 0');
});

test('resolveTarget: reply to running terminal', () => {
  const bindings = new Map([[10, { terminal_id: 'T-abc', chat_id: 1, kind: 'question' }]]);
  const terminals = new Map([['T-abc', terminal()]]);
  const u = update({ reply_to_message: { message_id: 10 }, text: 'yes' });
  assert.deepEqual(resolveTarget(u, bindings, terminals), {
    kind: 'reply',
    terminalId: 'T-abc',
    text: 'yes',
  });
});

test('resolveTarget: reply to exited terminal yields target_gone', () => {
  const bindings = new Map([[10, { terminal_id: 'T-abc', chat_id: 1, kind: 'question' }]]);
  const terminals = new Map([['T-abc', terminal({ status: 'exited' })]]);
  const u = update({ reply_to_message: { message_id: 10 }, text: 'yes' });
  assert.deepEqual(resolveTarget(u, bindings, terminals), {
    kind: 'target_gone',
    terminalId: 'T-abc',
  });
});

test('resolveTarget: reply binding wins over command-looking text', () => {
  const bindings = new Map([[10, { terminal_id: 'T-abc', chat_id: 1, kind: 'question' }]]);
  const terminals = new Map([['T-abc', terminal()]]);
  const u = update({ reply_to_message: { message_id: 10 }, text: '/status' });
  assert.deepEqual(resolveTarget(u, bindings, terminals), {
    kind: 'reply',
    terminalId: 'T-abc',
    text: '/status',
  });
});

test('resolveTarget: command parsing with args', () => {
  const u = update({ text: '/sessions all' });
  assert.deepEqual(resolveTarget(u, new Map(), new Map()), {
    kind: 'command',
    command: 'sessions',
    args: 'all',
  });
});

test('resolveTarget: prefix to running terminal', () => {
  const terminals = new Map([['T-abc', terminal()]]);
  const u = update({ text: 'T-abc: do it' });
  assert.deepEqual(resolveTarget(u, new Map(), terminals), {
    kind: 'prefix',
    terminalId: 'T-abc',
    text: 'do it',
  });
});

test('resolveTarget: prefix to exited terminal yields target_gone', () => {
  const terminals = new Map([['T-abc', terminal({ status: 'exited' })]]);
  const u = update({ text: 'T-abc: do it' });
  assert.deepEqual(resolveTarget(u, new Map(), terminals), {
    kind: 'target_gone',
    terminalId: 'T-abc',
  });
});

test('resolveTarget: single waiting session', () => {
  const terminals = new Map([
    ['T-abc', terminal({ isWaiting: true })],
    ['T-xyz', terminal({ id: 'T-xyz', isWaiting: false })],
  ]);
  const u = update({ text: 'go ahead' });
  assert.deepEqual(resolveTarget(u, new Map(), terminals), {
    kind: 'single',
    terminalId: 'T-abc',
    text: 'go ahead',
  });
});

test('resolveTarget: multiple waiting sessions yields unresolved', () => {
  const terminals = new Map([
    ['T-abc', terminal({ isWaiting: true })],
    ['T-xyz', terminal({ id: 'T-xyz', isWaiting: true })],
  ]);
  const u = update({ text: 'go ahead' });
  assert.deepEqual(resolveTarget(u, new Map(), terminals), { kind: 'unresolved' });
});

test('resolveTarget: zero waiting sessions yields unresolved', () => {
  const terminals = new Map([['T-abc', terminal({ isWaiting: false })]]);
  const u = update({ text: 'go ahead' });
  assert.deepEqual(resolveTarget(u, new Map(), terminals), { kind: 'unresolved' });
});

test('deliveredMsg: default and fallback variants', () => {
  assert.equal(deliveredMsg('T-abc'), '✅ delivered → T-abc');
  assert.equal(deliveredMsg('T-abc', { fallback: true }), '✅ delivered → T-abc (only waiting session)');
});

test('busyMsg / exitedMsg / failureMsg', () => {
  assert.equal(busyMsg('T-abc'), '⚠️ T-abc already has a pending reply — try again shortly');
  assert.equal(exitedMsg('T-abc'), '⚠️ T-abc has exited — reply not delivered');
  assert.equal(failureMsg('paste timeout'), '⚠️ injection failed: paste timeout');
});

test('unresolvedMsg: empty list and populated list', () => {
  assert.equal(unresolvedMsg([]), 'no sessions waiting');
  const list = [terminal({ work_item_id: 'W-1', questionText: 'Proceed?' })];
  assert.equal(unresolvedMsg(list), 'T-abc · ticari/architect/main · W-1 — Proceed?');
});

test('sessionsListMsg: header plus lines', () => {
  const list = [terminal({ questionText: 'Proceed?' })];
  assert.equal(sessionsListMsg(list), 'Waiting sessions:\nT-abc · ticari/architect/main — Proceed?');
});

test('buildQuestionNotification: explained uses summary and numbered options with blurbs', () => {
  const explained = {
    summary: 'Pick a deploy target.',
    options: [{ blurb: 'go live' }, { blurb: 'safe sandbox' }],
  };
  const options = [
    { n: 1, label: 'Production' },
    { n: 2, label: 'Staging' },
  ];
  const out = buildQuestionNotification(terminal({ work_item_id: 'W-1' }), explained, options, 'raw ignored');
  assert.equal(
    out,
    '🔔 T-abc · ticari/architect/main · W-1\n\nPick a deploy target.\n\n1. Production — go live\n2. Staging — safe sandbox',
  );
});

test('buildQuestionNotification: no explained uses rawText and bare numbered options', () => {
  const options = [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No' },
  ];
  const out = buildQuestionNotification(terminal(), null, options, 'Proceed with merge?');
  assert.equal(out, '🔔 T-abc · ticari/architect/main\n\nProceed with merge?\n\n1. Yes\n2. No');
});

test('buildQuestionNotification: empty options omits the option block', () => {
  const out = buildQuestionNotification(terminal(), null, [], 'Type your answer:');
  assert.equal(out, '🔔 T-abc · ticari/architect/main\n\nType your answer:');
});

test('confirmMsg: numbered choice with ok/cancel words', () => {
  const out = confirmMsg(terminal(), 2, 'Staging');
  assert.equal(
    out,
    '🔔 T-abc · ticari/architect/main\n→ 2. Staging\nSend `ok` to confirm, `cancel` to abort, or rephrase.',
  );
});

test('confirmMsg: free-text variant renders quoted text', () => {
  const out = confirmMsg(terminal(), null, 'restart the service');
  assert.equal(
    out,
    '🔔 T-abc · ticari/architect/main\n→ "restart the service"\nSend `ok` to confirm, `cancel` to abort, or rephrase.',
  );
});

test('cancelledMsg: correct string', () => {
  assert.equal(cancelledMsg('T-abc'), 'T-abc: cancelled — reply again to answer');
});

test('expiredMsg: header plus re-listed numbered options', () => {
  const options = [
    { n: 1, label: 'Yes' },
    { n: 2, label: 'No' },
  ];
  const out = expiredMsg(terminal(), options);
  assert.equal(
    out,
    '🔔 T-abc · ticari/architect/main\nthat question expired — here are the options again:\n1. Yes\n2. No',
  );
});

test('selectedMsg: numbered variant includes verify caveat', () => {
  assert.equal(
    selectedMsg('T-abc', 1, 'Production'),
    "✅ selected → 1. Production (verify in dashboard if it didn't take)",
  );
});

test('selectedMsg: free-text variant includes verify caveat', () => {
  assert.equal(
    selectedMsg('T-abc', null, 'restart'),
    '✅ sent: "restart" (verify in dashboard if it didn\'t take)',
  );
});

test('staleScreenMsg: correct string', () => {
  assert.equal(staleScreenMsg('T-abc'), '⚠️ T-abc — session moved on; re-check in dashboard');
});
