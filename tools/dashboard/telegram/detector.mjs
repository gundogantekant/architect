/**
 * Question detector for a Claude Ink TUI running over tmux.
 *
 * Emits a one-shot `needs_input` when Claude shows a question (a `dialog`
 * screen) or sits idle at a stable input composer, then re-arms once the
 * question clears. Spinner/clock noise above the composer never re-fires
 * because stabilization compares only the composer region.
 *
 * The core (`nextDetectorState`, `extractQuestionText`) is pure and timer-free.
 * All I/O (tmux capture, timers) is injected through `createQuestionDetector`.
 */

import {
  classifyClaudeScreen,
  inputRegion,
  inputRegionStable,
} from '../injection/claude-tmux.mjs';

const COMPOSER_ARROW = '❯';

function dialogLines(capture) {
  return (capture || '')
    .split('\n')
    .map(line => line.replace(/^[│╭╰]?\s*/, '').replace(/\s*[│╮╯]?\s*$/, ''))
    .map(line => line.trim())
    .filter(line => line !== '' && !/^[─━╭╮╰╯]+$/.test(line));
}

/**
 * Extract human-readable question text from a capture.
 *
 * For a dialog screen this is the prompt line plus the numbered-menu choices.
 * For an input screen it falls back to the composer region.
 * @param {string} capture
 * @returns {string}
 */
export function extractQuestionText(capture) {
  if (classifyClaudeScreen(capture) === 'dialog') {
    const lines = dialogLines(capture);
    const menu = lines.filter(line => /^[❯>]?\s*\d+\.\s/.test(line) || /^\d+\.\s/.test(line));
    const prompt = lines.filter(line => !/^[❯>]?\s*\d+\.\s/.test(line) && !/^\d+\.\s/.test(line));
    return [...prompt, ...menu].join('\n').trim();
  }
  const region = inputRegion(capture);
  return region === null ? '' : region.trim();
}

function isEmptyCapture(capture) {
  return capture == null || capture.trim() === '';
}

function composerChangedAfterFiring(prevCapture, capture) {
  if (prevCapture == null) return false;
  const prev = inputRegion(prevCapture);
  const cur = inputRegion(capture);
  if (prev === null || cur === null) return false;
  return prev !== cur;
}

/**
 * Pure transition: given the previous per-terminal state and a fresh capture,
 * compute the next state and whether a fire/clear edge occurred.
 *
 * @param {{lastClass:string, prevCapture:?string, stableCount:number, armed:boolean}} prevState
 * @param {?string} capture
 * @param {number} stableN
 * @returns {{state:string, questionText:string, fired:boolean, cleared:boolean,
 *            next:{lastClass:string, prevCapture:?string, stableCount:number, armed:boolean}}}
 */
export function nextDetectorState(prevState, capture, stableN = 2) {
  const armed = prevState.armed !== false;
  if (isEmptyCapture(capture)) {
    return {
      state: 'boot',
      questionText: '',
      fired: false,
      cleared: false,
      next: { lastClass: 'boot', prevCapture: capture, stableCount: 0, armed },
    };
  }

  const state = classifyClaudeScreen(capture);

  if (state === 'dialog') {
    const fired = armed;
    return {
      state,
      questionText: fired ? extractQuestionText(capture) : '',
      fired,
      cleared: false,
      next: { lastClass: state, prevCapture: capture, stableCount: 0, armed: false },
    };
  }

  if (state === 'input') {
    const wasQuestion = prevState.lastClass === 'dialog';
    const composerMoved = !armed && composerChangedAfterFiring(prevState.prevCapture, capture);
    if (wasQuestion || composerMoved) {
      return {
        state,
        questionText: '',
        fired: false,
        cleared: true,
        next: { lastClass: state, prevCapture: capture, stableCount: 0, armed: true },
      };
    }
    const stableCount = inputRegionStable(prevState.prevCapture, capture)
      ? prevState.stableCount + 1
      : 0;
    const fired = armed && stableCount >= stableN;
    return {
      state,
      questionText: fired ? extractQuestionText(capture) : '',
      fired,
      cleared: false,
      next: {
        lastClass: state,
        prevCapture: capture,
        stableCount,
        armed: fired ? false : armed,
      },
    };
  }

  const cleared = prevState.lastClass === 'dialog' || prevState.lastClass === 'input';
  return {
    state: 'boot',
    questionText: '',
    fired: false,
    cleared,
    next: { lastClass: 'boot', prevCapture: capture, stableCount: 0, armed: true },
  };
}

function initialState() {
  return { lastClass: 'boot', prevCapture: null, stableCount: 0, armed: true };
}

/**
 * Build a detector that tracks multiple tmux-backed terminals on one shared
 * interval. Injected deps keep it timer- and tmux-free for testing.
 *
 * @param {{
 *   tmuxCapturePane:(session:string)=>Promise<string>,
 *   onNeedsInput?:(terminal:object, questionText:string)=>void,
 *   onCleared?:(terminal:object)=>void,
 *   intervalMs?:number,
 *   stableN?:number,
 *   setIntervalFn?:Function,
 *   clearIntervalFn?:Function,
 * }} deps
 */
export function createQuestionDetector({
  tmuxCapturePane,
  onNeedsInput = () => {},
  onCleared = () => {},
  intervalMs = 500,
  stableN = 2,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) {
  const states = new Map();
  let timer = null;

  async function scanOnce(terminal) {
    const prevState = states.get(terminal.id) || initialState();
    const capture = await tmuxCapturePane(terminal.tmux_session);
    const result = nextDetectorState(prevState, capture, stableN);
    states.set(terminal.id, result.next);
    if (result.fired) onNeedsInput(terminal, result.questionText);
    if (result.cleared) onCleared(terminal);
    return { state: result.state, questionText: result.questionText, fired: result.fired };
  }

  function ensureTimer() {
    if (timer !== null || states.size === 0) return;
    timer = setIntervalFn(() => {
      for (const terminal of trackedTerminals.values()) scanOnce(terminal);
    }, intervalMs);
  }

  const trackedTerminals = new Map();

  function track(terminal) {
    trackedTerminals.set(terminal.id, terminal);
    if (!states.has(terminal.id)) states.set(terminal.id, initialState());
    ensureTimer();
  }

  function untrack(id) {
    trackedTerminals.delete(id);
    states.delete(id);
    if (trackedTerminals.size === 0) stop();
  }

  function stop() {
    if (timer !== null) {
      clearIntervalFn(timer);
      timer = null;
    }
  }

  return { track, untrack, scanOnce, stop };
}
