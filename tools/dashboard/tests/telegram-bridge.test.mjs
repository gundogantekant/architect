/**
 * Tests for the Telegram terminal bridge.
 *
 * Every dependency is faked — no pg, no network, no timers. The inbound loop is
 * driven one batch at a time via handle.pollOnce(). Covers allowlist gating,
 * reply routing, busy/exited replies, offset persistence/dedup across restart,
 * and startup reclassification of an already-waiting terminal.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { startTelegramBridge } from '../telegram/bridge.mjs';

const ALLOWED_CHAT = 555;

function fakeClient() {
  const sent = [];
  const batches = [];
  let messageId = 1000;
  return {
    sent,
    queue(batch) { batches.push(batch); },
    async sendMessage(payload) {
      sent.push(payload);
      return { message_id: ++messageId };
    },
    async getUpdates() {
      return batches.shift() ?? [];
    },
  };
}

function fakeDb() {
  const bindings = new Map();
  const prefs = {};
  return {
    bindings,
    prefs,
    async saveTelegramBinding({ message_id, terminal_id, chat_id, kind }) {
      bindings.set(message_id, { message_id, terminal_id, chat_id, kind });
    },
    async getTelegramBindingByMessageId(id) {
      return bindings.get(id) ?? null;
    },
    async pruneTelegramBindings() { return 0; },
    async getPreference(key) { return prefs[key] ?? null; },
    async setPreference(key, value) { prefs[key] = value; },
  };
}

function fakeDetector() {
  return {
    track() {},
    untrack() {},
    async scanOnce() { return { state: 'input', questionText: '', fired: false }; },
    stop() {},
  };
}

function fakeTerminalEvents() {
  const listeners = new Set();
  return {
    on(_event, fn) { listeners.add(fn); },
    removeListener(_event, fn) { listeners.delete(fn); },
    emit(_event, payload) { for (const fn of listeners) fn(payload); },
  };
}

function fakeLlmDeps(overrides = {}) {
  const calls = { explain: [], map: [], keys: [], capture: [] };
  return {
    calls,
    explainQuestion: overrides.explainQuestion ?? (async (args) => { calls.explain.push(args); return null; }),
    mapReplyToDecision: overrides.mapReplyToDecision ?? (async (text) => { calls.map.push(text); return { type: 'unclear' }; }),
    sendKeysToTerminal: overrides.sendKeysToTerminal ?? (async (terminal, keys) => { calls.keys.push(keys); }),
    capturePane: overrides.capturePane ?? (async (terminal) => { calls.capture.push(terminal.id); return ''; }),
    nowFn: overrides.nowFn ?? (() => 1000),
  };
}

function buildHandle(overrides = {}) {
  const client = overrides.client ?? fakeClient();
  const db = overrides.db ?? fakeDb();
  const terminals = overrides.terminals ?? new Map();
  const injectIntoTerminal = overrides.injectIntoTerminal ?? (async () => ({ ok: true }));
  const detector = overrides.detector ?? fakeDetector();
  const llm = fakeLlmDeps(overrides);
  const handle = startTelegramBridge({
    client,
    terminals,
    injectIntoTerminal,
    terminalEvents: overrides.terminalEvents ?? fakeTerminalEvents(),
    makeDetector: () => detector,
    db,
    explainQuestion: llm.explainQuestion,
    mapReplyToDecision: llm.mapReplyToDecision,
    sendKeysToTerminal: llm.sendKeysToTerminal,
    capturePane: llm.capturePane,
    nowFn: llm.nowFn,
    config: {
      enabled: false,
      notify_questions: true,
      notify_idle: false,
      notify_lifecycle: false,
      allowlist: [ALLOWED_CHAT],
      default_chat_id: ALLOWED_CHAT,
      ...overrides.config,
    },
    setTimeoutFn: (fn) => fn(),
    setIntervalFn: () => 0,
    clearIntervalFn: () => {},
    logger: { warn() {} },
  });
  return { handle, client, db, terminals, detector, llm };
}

function update(id, fields) {
  return { update_id: id, message: { message_id: id, chat: { id: ALLOWED_CHAT }, ...fields } };
}

const MENU_OPTIONS = [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }];
const DIALOG_CAPTURE = 'Proceed?\n1. Yes\n2. No';

function menuTerminal(id) {
  return {
    id,
    status: 'running',
    project_key: 'org/p/c',
    work_item_id: null,
    _tgQuestion: DIALOG_CAPTURE,
    _tgPrompt: 'Proceed?',
    _tgOptions: MENU_OPTIONS,
    _tgAnswerKind: 'menu',
  };
}

function boundReply(messageId, terminalId, updateId, text) {
  const db = fakeDb();
  db.bindings.set(messageId, { message_id: messageId, terminal_id: terminalId, chat_id: ALLOWED_CHAT, kind: 'question' });
  const event = update(updateId, { text, reply_to_message: { message_id: messageId } });
  return { db, event };
}

describe('telegram bridge inbound loop', () => {
  let ctx;
  beforeEach(() => { ctx = null; });

  it('drops updates from non-allowlisted chats but still advances offset', async () => {
    ctx = buildHandle({});
    const foreign = { update_id: 7, message: { message_id: 7, chat: { id: 999 }, text: 'hi' } };
    ctx.client.queue([foreign]);
    await ctx.handle.pollOnce();
    assert.equal(ctx.db.prefs.telegram_offset, '8');
    assert.equal(ctx.client.sent.length, 0);
  });

  it('maps a reply to an option and asks for confirmation without sending keys', async () => {
    const terminals = new Map([['T-1', menuTerminal('T-1')]]);
    const { db, event } = boundReply(900, 'T-1', 10, 'the second one');
    ctx = buildHandle({
      terminals,
      db,
      mapReplyToDecision: async () => ({ type: 'option', index: 2 }),
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(terminals.get('T-1')._tgPending.decision.index, 2);
    assert.equal(ctx.llm.calls.keys.length, 0);
    assert.match(ctx.client.sent.at(-1).text, /2\. No/);
    assert.match(ctx.client.sent.at(-1).text, /confirm/);
  });

  it('actuates a menu selection on confirm when the screen is still a dialog', async () => {
    const terminal = menuTerminal('T-1');
    terminal._tgPending = { decision: { type: 'option', index: 2 }, expiresAt: 5000 };
    const terminals = new Map([['T-1', terminal]]);
    const { db, event } = boundReply(900, 'T-1', 11, 'ok');
    ctx = buildHandle({
      terminals,
      db,
      capturePane: async () => DIALOG_CAPTURE,
      nowFn: () => 1000,
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.deepEqual(ctx.llm.calls.keys, [['2'], ['Enter']]);
    assert.equal(terminals.get('T-1')._tgPending, undefined);
    assert.equal(ctx.handle.status().waitingCount, 0);
    assert.match(ctx.client.sent.at(-1).text, /selected → 2\. No/);
  });

  it('reports a stale screen and sends no keys when the dialog has moved on', async () => {
    const terminal = menuTerminal('T-1');
    terminal._tgPending = { decision: { type: 'option', index: 2 }, expiresAt: 5000 };
    const terminals = new Map([['T-1', terminal]]);
    const { db, event } = boundReply(900, 'T-1', 12, 'ok');
    ctx = buildHandle({
      terminals,
      db,
      capturePane: async () => '❯ ready for input',
      nowFn: () => 1000,
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(ctx.llm.calls.keys.length, 0);
    assert.match(ctx.client.sent.at(-1).text, /session moved on/);
  });

  it('clears pending on cancel', async () => {
    const terminal = menuTerminal('T-1');
    terminal._tgPending = { decision: { type: 'option', index: 2 }, expiresAt: 5000 };
    const terminals = new Map([['T-1', terminal]]);
    const { db, event } = boundReply(900, 'T-1', 13, 'cancel');
    ctx = buildHandle({ terminals, db, nowFn: () => 1000 });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(terminals.get('T-1')._tgPending, undefined);
    assert.equal(ctx.llm.calls.keys.length, 0);
    assert.match(ctx.client.sent.at(-1).text, /cancelled/);
  });

  it('expires a stale pending and re-lists options without actuating', async () => {
    const terminal = menuTerminal('T-1');
    terminal._tgPending = { decision: { type: 'option', index: 2 }, expiresAt: 1000 };
    const terminals = new Map([['T-1', terminal]]);
    const { db, event } = boundReply(900, 'T-1', 14, 'ok');
    ctx = buildHandle({ terminals, db, nowFn: () => 9999 });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(terminals.get('T-1')._tgPending, undefined);
    assert.equal(ctx.llm.calls.keys.length, 0);
    assert.match(ctx.client.sent.at(-1).text, /expired/);
  });

  it('actuates a text answer via injectIntoTerminal, not sendKeys', async () => {
    const terminal = {
      id: 'T-1', status: 'running', project_key: 'p', work_item_id: null,
      _tgPrompt: 'What name?', _tgOptions: [], _tgAnswerKind: 'text',
    };
    terminal._tgPending = { decision: { type: 'text', value: 'widget' }, expiresAt: 5000 };
    const terminals = new Map([['T-1', terminal]]);
    const injected = [];
    const { db, event } = boundReply(900, 'T-1', 15, 'ok');
    ctx = buildHandle({
      terminals,
      db,
      nowFn: () => 1000,
      injectIntoTerminal: async (t, text) => { injected.push({ id: t.id, text }); return { ok: true }; },
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.deepEqual(injected, [{ id: 'T-1', text: 'widget' }]);
    assert.equal(ctx.llm.calls.keys.length, 0);
    assert.match(ctx.client.sent.at(-1).text, /sent: "widget"/);
  });

  it('degrades a reply with no pending and empty options to mapping without throwing', async () => {
    const terminals = new Map([['T-1', { id: 'T-1', status: 'running', project_key: 'p', work_item_id: null }]]);
    const { db, event } = boundReply(900, 'T-1', 16, 'whatever');
    let mapped = null;
    ctx = buildHandle({
      terminals,
      db,
      mapReplyToDecision: async (text, ctxArg) => { mapped = { text, ...ctxArg }; return { type: 'unclear' }; },
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(ctx.db.prefs.telegram_offset, '17');
    assert.deepEqual(mapped, { text: 'whatever', prompt: '', options: [] });
    assert.equal(ctx.llm.calls.keys.length, 0);
  });

  it('persists offset and does not re-process the same update on a second poll', async () => {
    const terminals = new Map([['T-1', menuTerminal('T-1')]]);
    const { db, event } = boundReply(903, 'T-1', 20, 'go');
    let mapCalls = 0;
    ctx = buildHandle({
      terminals,
      db,
      mapReplyToDecision: async () => { mapCalls++; return { type: 'unclear' }; },
    });
    ctx.client.queue([event]);
    await ctx.handle.pollOnce();
    assert.equal(db.prefs.telegram_offset, '21');
    ctx.client.queue([]);
    await ctx.handle.pollOnce();
    assert.equal(mapCalls, 1);
  });
});

describe('telegram bridge notification gating', () => {
  function buildGated(config) {
    const client = fakeClient();
    const db = fakeDb();
    const terminalEvents = fakeTerminalEvents();
    let callbacks = null;
    const handle = startTelegramBridge({
      client,
      terminals: new Map(),
      injectIntoTerminal: async () => ({ ok: true }),
      terminalEvents,
      makeDetector: (cbs) => { callbacks = cbs; return fakeDetector(); },
      db,
      explainQuestion: async () => null,
      mapReplyToDecision: async () => ({ type: 'unclear' }),
      sendKeysToTerminal: async () => {},
      capturePane: async () => '',
      nowFn: () => 1000,
      config: { enabled: true, allowlist: [ALLOWED_CHAT], default_chat_id: ALLOWED_CHAT, ...config },
      setTimeoutFn: (fn) => setTimeout(fn, 0),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      logger: { warn() {} },
    });
    return { client, terminalEvents, callbacks, handle };
  }

  function idleQuestion(text) {
    return { text, prompt: text, options: [], answerKind: 'text' };
  }

  function menuQuestion(text, prompt, options) {
    return { text, prompt, options, answerKind: 'menu' };
  }

  const terminal = { id: 'T-7', status: 'exited' };

  it('suppresses an idle event when notify_idle is false', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: false });
    await callbacks.onNeedsInput(terminal, idleQuestion('idle text'), 'idle');
    handle.stop();
    assert.equal(client.sent.length, 0);
  });

  it('sends an idle event when notify_idle is true', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: true });
    await callbacks.onNeedsInput(terminal, idleQuestion('idle text'), 'idle');
    handle.stop();
    assert.equal(client.sent.length, 1);
  });

  it('sends a question event when notify_questions is true', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: false });
    await callbacks.onNeedsInput(terminal, menuQuestion('Proceed?', 'Proceed?', [{ n: 1, label: 'Yes' }]), 'question');
    handle.stop();
    assert.equal(client.sent.length, 1);
  });

  it('suppresses a question event when notify_questions is false', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: false, notify_idle: false });
    await callbacks.onNeedsInput(terminal, menuQuestion('Proceed?', 'Proceed?', [{ n: 1, label: 'Yes' }]), 'question');
    handle.stop();
    assert.equal(client.sent.length, 0);
  });

  it('explains the question, sends the question notification, saves the binding, and stores state', async () => {
    const client = fakeClient();
    const db = fakeDb();
    let callbacks = null;
    const explainCalls = [];
    const running = { id: 'T-8', status: 'running', project_key: 'org/p/c', work_item_id: 'W-2' };
    const handle = startTelegramBridge({
      client,
      terminals: new Map([['T-8', running]]),
      injectIntoTerminal: async () => ({ ok: true }),
      terminalEvents: fakeTerminalEvents(),
      makeDetector: (cbs) => { callbacks = cbs; return fakeDetector(); },
      db,
      explainQuestion: async (args) => { explainCalls.push(args); return { summary: 'They ask whether to proceed.', options: [] }; },
      mapReplyToDecision: async () => ({ type: 'unclear' }),
      sendKeysToTerminal: async () => {},
      capturePane: async () => '',
      nowFn: () => 1000,
      config: { enabled: true, notify_questions: true, notify_idle: false, notify_lifecycle: false, allowlist: [ALLOWED_CHAT], default_chat_id: ALLOWED_CHAT },
      setTimeoutFn: () => 0,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      logger: { warn() {} },
    });
    await callbacks.onNeedsInput(running, menuQuestion('Proceed?\n1. Yes\n2. No', 'Proceed?', MENU_OPTIONS), 'question');
    handle.stop();
    assert.equal(explainCalls.length, 1);
    assert.equal(explainCalls[0].projectKey, 'org/p/c');
    assert.equal(explainCalls[0].workItemId, 'W-2');
    assert.match(client.sent.at(-1).text, /They ask whether to proceed\./);
    assert.deepEqual(running._tgOptions, MENU_OPTIONS);
    assert.equal(running._tgAnswerKind, 'menu');
    const bound = [...db.bindings.values()].find(b => b.terminal_id === 'T-8');
    assert.equal(bound.kind, 'question');
  });

  it('does not emit a lifecycle ping on exit when notify_lifecycle is false', async () => {
    const { client, terminalEvents, handle } = buildGated({ notify_lifecycle: false });
    terminalEvents.emit('exit', terminal);
    await new Promise(r => setTimeout(r, 5));
    handle.stop();
    assert.equal(client.sent.length, 0);
  });

  it('emits a lifecycle ping on exit when notify_lifecycle is true', async () => {
    const { client, terminalEvents, handle } = buildGated({ notify_lifecycle: true });
    terminalEvents.emit('exit', terminal);
    await new Promise(r => setTimeout(r, 5));
    handle.stop();
    assert.equal(client.sent.length, 1);
  });
});

describe('telegram bridge startup reclassification', () => {
  it('emits a question ping for an already-waiting terminal on start', async () => {
    const client = fakeClient();
    const db = fakeDb();
    const terminals = new Map([
      ['T-9', { id: 'T-9', status: 'running', project_key: 'org/p/c', work_item_id: 'W-1' }],
    ]);
    const question = {
      text: 'Proceed?\n1. Yes\n2. No',
      prompt: 'Proceed?',
      options: [{ n: 1, label: 'Yes' }, { n: 2, label: 'No' }],
      answerKind: 'menu',
    };
    const detector = {
      track() {},
      untrack() {},
      async scanOnce() { return { state: 'dialog', question, fired: true, kind: 'question' }; },
      stop() {},
    };
    const handle = startTelegramBridge({
      client,
      terminals,
      injectIntoTerminal: async () => ({ ok: true }),
      terminalEvents: fakeTerminalEvents(),
      makeDetector: () => detector,
      db,
      explainQuestion: async () => null,
      mapReplyToDecision: async () => ({ type: 'unclear' }),
      sendKeysToTerminal: async () => {},
      capturePane: async () => '',
      nowFn: () => 1000,
      config: { enabled: true, notify_questions: true, notify_idle: false, notify_lifecycle: false, allowlist: [ALLOWED_CHAT], default_chat_id: ALLOWED_CHAT },
      setTimeoutFn: () => 0,
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      logger: { warn() {} },
    });
    // Allow the start chain (loadOffset -> reclassifyOnStart) to settle, then stop the loop.
    while (client.sent.length === 0) await new Promise(r => setTimeout(r, 5));
    handle.stop();
    await new Promise(r => setTimeout(r, 5));
    assert.equal(client.sent.length >= 1, true);
    assert.match(client.sent[0].text, /T-9/);
    assert.match(client.sent[0].text, /Proceed\?/);
    assert.equal(handle.status().waitingCount, 1);
    const bound = [...db.bindings.values()].find(b => b.terminal_id === 'T-9');
    assert.equal(bound.kind, 'question');
  });
});
