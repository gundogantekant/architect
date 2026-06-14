/**
 * Integration tests for the tmux prompt-injection state machine ordering.
 *
 * The state machine in injection/index.mjs is driven through a controllable
 * fake clock (deps.setTimeout/clearTimeout) and fully mocked tmux exec helpers,
 * so no real tmux server is needed. Each poll tick is advanced explicitly, which
 * makes the capture→classify→deliver ordering observable and deterministic.
 *
 * Test 1 additionally exercises the REAL pty-manager onData wiring to prove the
 * stream-readiness PTY-write arm is disabled for tmux sessions — the original
 * W-1257 bug lived in that wiring, not in a predicate.
 *
 * Fixtures use the recorded `────…❯` composer format (the arrow rendered at the
 * end of a horizontal-rule line) from tmp/dispatch-injection-test/*.events.json.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

import { startInjection } from '../injection/index.mjs';
import { wireTerminalHandlers } from '../pty-manager.mjs';
import claudeAdapter from '../adapters/claude.mjs';

const DASHBOARD_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

// Bare-arrow composer (❯ at line start) — the format classifyClaudeScreen
// currently recognizes as input. This isolates the ordering machine from the
// recorded-format recognition bug documented in claude-tmux-predicates.test.mjs.
const INPUT_READY = ['  ⚠ ready', '', '❯ '].join('\n');
const BOOT = ['  ✻ Claude Code starting…', '', '  loading'].join('\n');
const DIALOG = ['Do you trust the files in this folder?', ' ❯ 1. Yes', '   2. No'].join('\n');
const PASTED_MARKER = '[Pasted text #1 +3 lines]';

class FakeClock {
  constructor() {
    this.queue = [];
    this.seq = 0;
  }
  setTimeout = (fn) => {
    const id = ++this.seq;
    this.queue.push({ id, fn });
    return id;
  };
  clearTimeout = (id) => {
    this.queue = this.queue.filter(t => t.id !== id);
  };
  async tick() {
    const next = this.queue.shift();
    if (!next) return false;
    await next.fn();
    return true;
  }
  async drain(limit = 100) {
    let count = 0;
    while (await this.tick()) {
      if (++count > limit) throw new Error('clock drain exceeded limit — possible infinite re-arm');
    }
    return count;
  }
}

function makeDeps(overrides = {}) {
  const calls = {
    capture: [],
    paste: [],
    clear: [],
    enter: [],
    inject: [],
    meta: [],
  };
  const clock = new FakeClock();
  const deps = {
    tmuxCapturePane: async (name) => { calls.capture.push(name); return ''; },
    tmuxPasteStdin: async (name, text) => { calls.paste.push({ name, text }); },
    tmuxClearInput: async (name) => { calls.clear.push(name); },
    tmuxSendEnter: async (name) => { calls.enter.push(name); return true; },
    injectPrompt: async (terminal) => { calls.inject.push(terminal.id); },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    appendFileSync: () => {},
    termEventLogPath: (id) => `/tmp/${id}.jsonl`,
    capMs: 8000,
    ...overrides,
  };
  return { deps, calls, clock };
}

function makeTerminal(prompt) {
  const meta = [];
  const terminal = {
    id: `tmux-test-${Math.random().toString(36).slice(2)}`,
    tmux_session: 'architect-test',
    _pendingPrompt: prompt,
    _delivering: false,
    ptyProcess: { pid: 4242 },
    eventStream: {
      append: (type, payload) => {
        const event = { type, payload };
        if (type === 'meta') meta.push(payload);
        return event;
      },
      broadcast: () => {},
    },
  };
  return { terminal, meta };
}

function statuses(meta) {
  return meta.filter(m => m.key === 'prompt_injection_status').map(m => m.value);
}
function details(meta) {
  return meta.filter(m => m.key === 'prompt_injection_detail').map(m => m.value);
}

describe('tmux injection ordering', () => {
  it('1: tmux terminal does NOT trigger a PTY-write injection on early ?2004h (stream arm disabled)', () => {
    let onDataCb = null;
    const writes = [];
    const terminal = {
      id: 'tmux-wiring',
      tmux_session: 'architect-wiring',
      _pendingPrompt: 'hello prompt',
      _readyForPrompt: false,
      _accumulated: '',
      _adapter: claudeAdapter,
      claude_session_id: 'already-set',
      ptyProcess: {
        pid: 99,
        write: (d) => writes.push(d),
        on: () => {},
        onData: (cb) => { onDataCb = cb; },
        onExit: () => {},
      },
      eventStream: {
        append: (type, payload) => ({ type, payload }),
        broadcast: () => {},
        subscribers: new Map(),
      },
    };

    wireTerminalHandlers(terminal);
    assert.ok(onDataCb, 'onData handler must be registered');

    // The early bracketed-paste-enable byte that tmux emits on attach.
    onDataCb('\x1b[?2004h');

    assert.equal(claudeAdapter.detectReadiness('', '\x1b[?2004h'), true,
      'precondition: the non-tmux path would have fired on this byte');
    assert.equal(terminal._readyForPrompt, false,
      'tmux session must NOT be marked ready by the stream arm');
    assert.equal(writes.length, 0, 'no PTY-write injection may occur for a tmux session');
    assert.equal(terminal._pendingPrompt, 'hello prompt', 'prompt stays pending for the capture machine');
  });

  it('2a: boot then stable input → delivery fires only after stable input', async () => {
    // boot → input → input(stable→deliver) → verify(marker) → post-enter capture
    const seq = [BOOT, INPUT_READY, INPUT_READY, PASTED_MARKER, INPUT_READY];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
    });
    const { terminal, meta } = makeTerminal('do the thing');

    startInjection(terminal, deps);
    await clock.drain();

    assert.deepEqual(statuses(meta).slice(-1), ['done'], 'must end done');
    assert.equal(calls.paste.length, 1, 'exactly one paste after stable input');
    assert.equal(calls.enter.length, 1, 'exactly one submit');
    assert.ok(details(meta).includes('delivered_submitted'));
  });

  it('2b: dialog-only run ends failed/blocked_on_dialog with ZERO pastes', async () => {
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return DIALOG; },
    });
    const { terminal, meta } = makeTerminal('do the thing');

    startInjection(terminal, deps);
    await clock.drain();

    assert.deepEqual(statuses(meta).slice(-1), ['failed'], 'dialog run must end failed');
    assert.ok(details(meta).includes('blocked_on_dialog'), 'must record blocked_on_dialog');
    assert.equal(calls.paste.length, 0, 'NO paste into a dialog');
    assert.equal(calls.enter.length, 0, 'NO submit into a dialog');
  });

  it('3: multi-line prompt → exactly one paste with full text and exactly one enter', async () => {
    const prompt = ['line one of instructions', 'line two with detail', 'line three: constraints'].join('\n');
    const seq = [INPUT_READY, INPUT_READY, PASTED_MARKER, INPUT_READY];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
    });
    const { terminal } = makeTerminal(prompt);

    startInjection(terminal, deps);
    await clock.drain();

    assert.equal(calls.paste.length, 1, 'exactly one tmuxPasteStdin');
    assert.equal(calls.enter.length, 1, 'exactly one tmuxSendEnter');
    assert.equal(calls.paste[0].text, prompt, 'paste must receive the full multi-line prompt');
  });

  it('4: first post-paste capture lacks marker → one re-paste (retry) then submit; delivery exactly once', async () => {
    // poll input, poll input (stable) → deliver:
    //   clear, paste, verify(no marker) → retry: clear, paste, verify(marker) → enter, post-capture
    const seq = [
      INPUT_READY,        // poll 1
      INPUT_READY,        // poll 2 (stable → deliver)
      INPUT_READY,        // verify after paste attempt 0: NO marker
      PASTED_MARKER,      // verify after paste attempt 1 (retry): marker present
      INPUT_READY,        // post-enter capture
    ];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
    });
    const { terminal, meta } = makeTerminal('retry me');

    startInjection(terminal, deps);
    await clock.drain();

    assert.equal(calls.clear.length, 2, 'one clear per paste attempt (original + retry)');
    assert.equal(calls.paste.length, 2, 'exactly one re-paste on missing marker');
    assert.equal(calls.enter.length, 1, 'submit happens exactly once');
    assert.equal(details(meta).filter(d => d === 'retry').length, 1, 'exactly one retry detail');
    assert.equal(statuses(meta).filter(s => s === 'done').length, 1, 'delivery (done) emitted exactly once');
  });

  it('4b: the _delivering claim prevents double delivery when poll and cap both reach input', async () => {
    // capMs:0 makes both the stability poll AND the cap branch eligible on the
    // same tick; the synchronous _delivering claim must collapse them to one.
    let i = 0;
    const seq = [INPUT_READY, PASTED_MARKER, INPUT_READY];
    const { deps, calls, clock } = makeDeps({
      capMs: 0,
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
    });
    const { terminal, meta } = makeTerminal('once only');

    startInjection(terminal, deps);
    await clock.drain();

    assert.equal(calls.paste.length, 1, 'exactly one paste despite poll+cap both firing');
    assert.equal(calls.enter.length, 1, 'exactly one submit');
    assert.equal(statuses(meta).filter(s => s === 'done').length, 1, 'done emitted exactly once');
  });

  it('helper: tmuxPasteStdin builds a paste-buffer argv carrying -r (LF→CR regression guard)', () => {
    // mock.module for execFile needs an experimental flag the suite does not
    // enable; a static-source guard keeps the -r flag from silently regressing
    // (without it tmux rewrites each LF to CR and re-fragments multi-line input).
    const source = readFileSync(join(DASHBOARD_DIR, 'utils.mjs'), 'utf8');
    const pasteBufferLine = source.split('\n').find(l => l.includes("'paste-buffer'"));
    assert.ok(pasteBufferLine, 'tmuxPasteStdin must invoke paste-buffer');
    assert.match(pasteBufferLine, /'-r'/, "paste-buffer argv must include '-r'");
  });

  it('5: hard tmuxPasteStdin exception → fallback_pty_write detail + injectPrompt called once', async () => {
    const seq = [INPUT_READY, INPUT_READY];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
      tmuxPasteStdin: async () => { throw new Error('tmux exec failed'); },
    });
    const { terminal, meta } = makeTerminal('fallback me');

    startInjection(terminal, deps);
    await clock.drain();

    assert.ok(details(meta).includes('fallback_pty_write'), 'must record fallback_pty_write');
    assert.equal(calls.inject.length, 1, 'injectPrompt must be called exactly once');
    assert.equal(calls.enter.length, 0, 'no submit on the failed tmux path');
  });

  it('6: verified paste but tmuxSendEnter fails → delivered_unverified, NOT done, no re-inject', async () => {
    // paste lands, but Enter fails. Content is already in the composer, so the
    // injector must mark delivered_unverified and stop — never re-inject (double).
    const seq = [INPUT_READY, INPUT_READY, PASTED_MARKER, PASTED_MARKER];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
      tmuxSendEnter: async (name) => { calls.enter.push(name); return false; },
    });
    const { terminal, meta } = makeTerminal('enter will fail');

    startInjection(terminal, deps);
    await clock.drain();

    assert.ok(!statuses(meta).includes('done'), 'must NOT emit done when Enter fails');
    assert.ok(!details(meta).includes('delivered_submitted'), 'must NOT claim delivered_submitted');
    assert.ok(details(meta).includes('delivered_unverified'), 'must record delivered_unverified');
    assert.equal(calls.inject.length, 0, 'must NOT re-inject (would double the content)');
    assert.equal(calls.paste.length, 1, 'exactly one paste — no re-inject');
  });

  it('7: Enter succeeds but composer still shows the paste post-Enter → delivered_unverified, no re-inject', async () => {
    // Post-Enter capture STILL contains the landed marker → the turn never
    // started. Must mark delivered_unverified and stop (no re-inject double).
    const seq = [INPUT_READY, INPUT_READY, PASTED_MARKER, PASTED_MARKER];
    let i = 0;
    const { deps, calls, clock } = makeDeps({
      tmuxCapturePane: async (name) => { calls.capture.push(name); return seq[Math.min(i++, seq.length - 1)]; },
    });
    const { terminal, meta } = makeTerminal('composer will not clear');

    startInjection(terminal, deps);
    await clock.drain();

    assert.ok(!statuses(meta).includes('done'), 'must NOT emit done when composer still shows the paste');
    assert.ok(!details(meta).includes('delivered_submitted'), 'must NOT claim delivered_submitted');
    assert.ok(details(meta).includes('delivered_unverified'), 'must record delivered_unverified');
    assert.equal(calls.enter.length, 1, 'Enter was sent exactly once');
    assert.equal(calls.inject.length, 0, 'must NOT re-inject (would double the content)');
  });
});
