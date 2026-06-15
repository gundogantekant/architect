/**
 * Tests for the tmux question detector.
 *
 * Drives the pure core (`nextDetectorState`) and the injected scanner
 * (`scanOnce`) with the real `classifyClaudeScreen` predicate and crafted
 * capture sequences. No real tmux or timers are used.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  createQuestionDetector,
  nextDetectorState,
  extractQuestionText,
} from '../telegram/detector.mjs';

const RULE = '────────────────────────────────────────────────────────────────────────────────';

const BOOT = ['', '  ✻ Claude Code starting…', '', '  Loading session and tools', ''].join('\n');

const composer = (spinner) => [spinner, '', RULE + '❯ '].join('\n');

const INPUT_IDLE = composer('  ✻ Ready');
const INPUT_SPINNER_TICK1 = composer('  ✶ Thinking… (12s · ↑ 1.2k tokens)');
const INPUT_SPINNER_TICK2 = composer('  ✻ Thinking… (13s · ↑ 1.4k tokens)');

const DIALOG_TRUST = [
  '╭──────────────────────────────────────────────────────────────╮',
  '│ Do you trust the files in this folder?                       │',
  '│                                                              │',
  '│ ❯ 1. Yes, proceed                                            │',
  '│   2. No, exit                                                │',
  '╰──────────────────────────────────────────────────────────────╯',
].join('\n');

const DIALOG_LOGIN = [
  'Select login method:',
  '',
  ' ❯ 1. Claude account with subscription',
  '   2. Anthropic Console account',
].join('\n');

function runSequence(captures, stableN = 2) {
  let state = { lastClass: 'boot', prevCapture: null, stableCount: 0, armed: true };
  const results = [];
  for (const capture of captures) {
    const r = nextDetectorState(state, capture, stableN);
    state = r.next;
    results.push(r);
  }
  return results;
}

describe('nextDetectorState', () => {
  it('fires once when boot transitions to a dialog', () => {
    const results = runSequence([BOOT, DIALOG_TRUST, DIALOG_TRUST]);
    assert.equal(results[0].fired, false);
    assert.equal(results[1].fired, true);
    assert.equal(results[1].state, 'dialog');
    assert.equal(results[1].kind, 'question');
    assert.ok(results[1].questionText.includes('Do you trust'));
    assert.equal(results[2].fired, false);
  });

  it('fires once when input is stable for stableN ticks', () => {
    const results = runSequence([INPUT_IDLE, INPUT_IDLE, INPUT_IDLE, INPUT_IDLE], 2);
    const firedFlags = results.map(r => r.fired);
    assert.deepEqual(firedFlags, [false, false, true, false]);
    assert.equal(results[2].kind, 'idle');
  });

  it('does not extra-fire or suppress when a spinner line above the composer changes', () => {
    const seq = [INPUT_SPINNER_TICK1, INPUT_SPINNER_TICK2, INPUT_SPINNER_TICK1, INPUT_SPINNER_TICK2];
    const results = runSequence(seq, 2);
    const fired = results.map(r => r.fired);
    assert.deepEqual(fired, [false, false, true, false]);
  });

  it('re-arms and fires a SECOND dialog after the first one clears to boot', () => {
    const results = runSequence([DIALOG_TRUST, BOOT, DIALOG_LOGIN]);
    assert.equal(results[0].fired, true);
    assert.equal(results[1].fired, false);
    assert.equal(results[1].cleared, true);
    assert.equal(results[2].fired, true);
    assert.ok(results[2].questionText.includes('Select login method'));
  });

  it('re-arms when a dialog clears straight to an input composer', () => {
    const results = runSequence([DIALOG_TRUST, INPUT_IDLE, INPUT_IDLE, INPUT_IDLE], 2);
    assert.equal(results[0].fired, true);
    assert.equal(results[1].cleared, true);
    assert.equal(results[1].fired, false);
    assert.equal(results[3].fired, true);
  });

  it('never fires on empty or null captures', () => {
    const results = runSequence(['', null, '   ']);
    assert.deepEqual(results.map(r => r.fired), [false, false, false]);
    assert.deepEqual(results.map(r => r.state), ['boot', 'boot', 'boot']);
  });
});

describe('extractQuestionText', () => {
  it('returns the dialog prompt plus numbered-menu lines', () => {
    const text = extractQuestionText(DIALOG_LOGIN);
    assert.ok(text.includes('Select login method'));
    assert.ok(text.includes('1. Claude account with subscription'));
    assert.ok(text.includes('2. Anthropic Console account'));
  });

  it('returns the composer region for an input screen', () => {
    const text = extractQuestionText(INPUT_IDLE);
    assert.ok(text.includes('❯'));
  });
});

describe('createQuestionDetector scanOnce', () => {
  function fakeTmux(sequence) {
    let i = 0;
    return async () => sequence[Math.min(i++, sequence.length - 1)];
  }

  it('calls onNeedsInput once for a stable input and reports fired', async () => {
    const captures = [INPUT_IDLE, INPUT_IDLE, INPUT_IDLE, INPUT_IDLE];
    const needs = [];
    const detector = createQuestionDetector({
      tmuxCapturePane: fakeTmux(captures),
      onNeedsInput: (terminal, q, kind) => needs.push({ id: terminal.id, q, kind }),
      stableN: 2,
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });
    const terminal = { id: 'T-1', tmux_session: 'sess-1' };
    detector.track(terminal);
    const r0 = await detector.scanOnce(terminal);
    const r1 = await detector.scanOnce(terminal);
    const r2 = await detector.scanOnce(terminal);
    const r3 = await detector.scanOnce(terminal);
    assert.equal(r0.fired, false);
    assert.equal(r1.fired, false);
    assert.equal(r2.fired, true);
    assert.equal(r2.kind, 'idle');
    assert.equal(r3.fired, false);
    assert.equal(needs.length, 1);
    assert.equal(needs[0].id, 'T-1');
    assert.equal(needs[0].kind, 'idle');
    detector.untrack(terminal.id);
  });

  it('reports kind question and passes it to onNeedsInput for a dialog', async () => {
    const captures = [DIALOG_TRUST];
    const needs = [];
    const detector = createQuestionDetector({
      tmuxCapturePane: fakeTmux(captures),
      onNeedsInput: (terminal, q, kind) => needs.push({ id: terminal.id, kind }),
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });
    const terminal = { id: 'T-5', tmux_session: 'sess-5' };
    detector.track(terminal);
    const r0 = await detector.scanOnce(terminal);
    assert.equal(r0.fired, true);
    assert.equal(r0.kind, 'question');
    assert.deepEqual(needs, [{ id: 'T-5', kind: 'question' }]);
    detector.untrack(terminal.id);
  });

  it('calls onCleared when a dialog clears', async () => {
    const captures = [DIALOG_TRUST, BOOT];
    const cleared = [];
    const detector = createQuestionDetector({
      tmuxCapturePane: fakeTmux(captures),
      onCleared: (terminal) => cleared.push(terminal.id),
      setIntervalFn: () => null,
      clearIntervalFn: () => {},
    });
    const terminal = { id: 'T-2', tmux_session: 'sess-2' };
    detector.track(terminal);
    await detector.scanOnce(terminal);
    await detector.scanOnce(terminal);
    assert.deepEqual(cleared, ['T-2']);
    detector.untrack(terminal.id);
  });

  it('drives a shared interval that scans tracked terminals', () => {
    let tick = null;
    const detector = createQuestionDetector({
      tmuxCapturePane: async () => INPUT_IDLE,
      setIntervalFn: (fn) => { tick = fn; return 'timer-id'; },
      clearIntervalFn: () => {},
    });
    detector.track({ id: 'T-3', tmux_session: 'sess-3' });
    assert.equal(typeof tick, 'function');
    detector.untrack('T-3');
  });
});
