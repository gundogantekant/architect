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

function buildHandle(overrides = {}) {
  const client = overrides.client ?? fakeClient();
  const db = overrides.db ?? fakeDb();
  const terminals = overrides.terminals ?? new Map();
  const injectIntoTerminal = overrides.injectIntoTerminal ?? (async () => ({ ok: true }));
  const detector = overrides.detector ?? fakeDetector();
  const handle = startTelegramBridge({
    client,
    terminals,
    injectIntoTerminal,
    terminalEvents: overrides.terminalEvents ?? fakeTerminalEvents(),
    makeDetector: () => detector,
    db,
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
  return { handle, client, db, terminals, detector };
}

function update(id, fields) {
  return { update_id: id, message: { message_id: id, chat: { id: ALLOWED_CHAT }, ...fields } };
}

describe('telegram bridge inbound loop', () => {
  let ctx;
  beforeEach(() => { ctx = null; });

  it('drops updates from non-allowlisted chats but still advances offset', async () => {
    let injectCalls = 0;
    ctx = buildHandle({ injectIntoTerminal: async () => { injectCalls++; return { ok: true }; } });
    const foreign = { update_id: 7, message: { message_id: 7, chat: { id: 999 }, text: 'hi' } };
    ctx.client.queue([foreign]);
    await ctx.handle.pollOnce();
    assert.equal(injectCalls, 0);
    assert.equal(ctx.db.prefs.telegram_offset, '8');
    assert.equal(ctx.client.sent.length, 0);
  });

  it('routes a reply to the bound terminal and confirms delivery', async () => {
    const terminals = new Map([
      ['T-1', { id: 'T-1', status: 'running', project_key: 'org/p/c', work_item_id: null }],
    ]);
    const injected = [];
    const db = fakeDb();
    db.bindings.set(900, { message_id: 900, terminal_id: 'T-1', chat_id: ALLOWED_CHAT, kind: 'question' });
    ctx = buildHandle({
      terminals,
      db,
      injectIntoTerminal: async (terminal, text) => { injected.push({ id: terminal.id, text }); return { ok: true }; },
    });
    ctx.client.queue([update(10, { text: 'yes proceed', reply_to_message: { message_id: 900 } })]);
    await ctx.handle.pollOnce();
    assert.deepEqual(injected, [{ id: 'T-1', text: 'yes proceed' }]);
    assert.match(ctx.client.sent.at(-1).text, /delivered → T-1/);
  });

  it('replies busy when injection reports busy', async () => {
    const terminals = new Map([['T-2', { id: 'T-2', status: 'running', project_key: 'p', work_item_id: null }]]);
    const db = fakeDb();
    db.bindings.set(901, { message_id: 901, terminal_id: 'T-2', chat_id: ALLOWED_CHAT, kind: 'question' });
    ctx = buildHandle({ terminals, db, injectIntoTerminal: async () => ({ ok: false, reason: 'busy' }) });
    ctx.client.queue([update(11, { text: 'answer', reply_to_message: { message_id: 901 } })]);
    await ctx.handle.pollOnce();
    assert.match(ctx.client.sent.at(-1).text, /already has a pending reply/);
  });

  it('replies exited when injection reports not_running', async () => {
    const terminals = new Map([['T-3', { id: 'T-3', status: 'running', project_key: 'p', work_item_id: null }]]);
    const db = fakeDb();
    db.bindings.set(902, { message_id: 902, terminal_id: 'T-3', chat_id: ALLOWED_CHAT, kind: 'question' });
    ctx = buildHandle({ terminals, db, injectIntoTerminal: async () => ({ ok: false, reason: 'not_running' }) });
    ctx.client.queue([update(12, { text: 'answer', reply_to_message: { message_id: 902 } })]);
    await ctx.handle.pollOnce();
    assert.match(ctx.client.sent.at(-1).text, /has exited/);
  });

  it('persists offset and does not re-process the same update on a second poll', async () => {
    const terminals = new Map([['T-4', { id: 'T-4', status: 'running', project_key: 'p', work_item_id: null }]]);
    const db = fakeDb();
    db.bindings.set(903, { message_id: 903, terminal_id: 'T-4', chat_id: ALLOWED_CHAT, kind: 'question' });
    let injectCalls = 0;
    ctx = buildHandle({ terminals, db, injectIntoTerminal: async () => { injectCalls++; return { ok: true }; } });
    ctx.client.queue([update(20, { text: 'go', reply_to_message: { message_id: 903 } })]);
    await ctx.handle.pollOnce();
    assert.equal(db.prefs.telegram_offset, '21');
    // Simulated restart backlog already consumed: getUpdates returns empty for offset 21.
    ctx.client.queue([]);
    await ctx.handle.pollOnce();
    assert.equal(injectCalls, 1);
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
      config: { enabled: true, allowlist: [ALLOWED_CHAT], default_chat_id: ALLOWED_CHAT, ...config },
      setTimeoutFn: (fn) => setTimeout(fn, 0),
      setIntervalFn: () => 0,
      clearIntervalFn: () => {},
      logger: { warn() {} },
    });
    return { client, terminalEvents, callbacks, handle };
  }

  const terminal = { id: 'T-7', status: 'exited' };

  it('suppresses an idle event when notify_idle is false', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: false });
    await callbacks.onNeedsInput(terminal, 'idle text', 'idle');
    handle.stop();
    assert.equal(client.sent.length, 0);
  });

  it('sends an idle event when notify_idle is true', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: true });
    await callbacks.onNeedsInput(terminal, 'idle text', 'idle');
    handle.stop();
    assert.equal(client.sent.length, 1);
  });

  it('sends a question event when notify_questions is true', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: true, notify_idle: false });
    await callbacks.onNeedsInput(terminal, 'q text', 'question');
    handle.stop();
    assert.equal(client.sent.length, 1);
  });

  it('suppresses a question event when notify_questions is false', async () => {
    const { client, callbacks, handle } = buildGated({ notify_questions: false, notify_idle: false });
    await callbacks.onNeedsInput(terminal, 'q text', 'question');
    handle.stop();
    assert.equal(client.sent.length, 0);
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
    const detector = {
      track() {},
      untrack() {},
      async scanOnce() { return { state: 'dialog', questionText: 'Proceed?\n1. Yes\n2. No', fired: true }; },
      stop() {},
    };
    const handle = startTelegramBridge({
      client,
      terminals,
      injectIntoTerminal: async () => ({ ok: true }),
      terminalEvents: fakeTerminalEvents(),
      makeDetector: () => detector,
      db,
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
