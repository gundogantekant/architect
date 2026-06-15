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
