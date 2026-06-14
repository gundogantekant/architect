/**
 * Single injector seam — owns the transport decision and exactly-once delivery.
 *
 * tmux sessions run a capture-driven state machine (Claude's Ink input mounts
 * AFTER the early `?2004h`, so the stream-readiness PTY write loses the paste).
 * Non-tmux sessions preserve today's stream-readiness behavior unchanged.
 *
 * All tmux exec + the clock are injected via `deps` so the machine is unit
 * testable without a real tmux server.
 */
import { classifyClaudeScreen, inputRegionStable, inputRegion } from './claude-tmux.mjs';
import { stripAnsi } from '../lib/ansi.mjs';

const POLL_INTERVAL_MS = 250;
const DEFAULT_CAP_MS = 8000;
const MAX_PASTE_RETRIES = 2;

function emitStatus(terminal, deps, status) {
  emitMeta(terminal, deps, 'prompt_injection_status', status);
}

function emitDetail(terminal, deps, detail) {
  emitMeta(terminal, deps, 'prompt_injection_detail', detail);
}

function emitMeta(terminal, deps, key, value) {
  const event = terminal.eventStream.append('meta', { key, value });
  try { deps.appendFileSync(deps.termEventLogPath(terminal.id), JSON.stringify(event) + '\n'); } catch {}
  terminal.eventStream.broadcast(event);
}

// Returns the marker substring that proves the paste landed in the composer, or
// null if it has not landed. The same marker is used post-Enter to confirm the
// composer cleared (turn submitted): if it is gone, the turn started.
function landedMarker(capture, prompt) {
  const pastedPlaceholder = capture.match(/\[Pasted text #\d+/);
  if (pastedPlaceholder) return pastedPlaceholder[0];
  const firstLine = prompt.split('\n')[0].trim();
  const needle = firstLine.slice(0, 40);
  if (firstLine.length >= 8 && capture.includes(needle)) return needle;
  return null;
}

/**
 * @param {object} terminal - the terminal record (has tmux_session, _pendingPrompt, eventStream)
 * @param {object} deps - injected dependencies:
 *   {
 *     tmuxCapturePane, tmuxPasteStdin, tmuxClearInput, tmuxSendEnter,  // async tmux helpers
 *     injectPrompt,                                                    // non-tmux / fallback PTY path
 *     setTimeout, clearTimeout,                                        // clock seam
 *     appendFileSync, termEventLogPath,                               // meta logging
 *     capMs?                                                          // hard cap (defaults to 8000)
 *   }
 */
export function startInjection(terminal, deps) {
  if (!terminal._pendingPrompt) return;

  if (!terminal.tmux_session) {
    // Non-tmux: the pty-manager stream-readiness arm + the terminal-session
    // fallback timer drive injectPrompt. Nothing to own here.
    return;
  }

  runTmuxInjection(terminal, deps);
}

async function runTmuxInjection(terminal, deps) {
  const name = terminal.tmux_session;
  const sanitized = stripAnsi(terminal._pendingPrompt || '');
  const capMs = deps.capMs ?? DEFAULT_CAP_MS;
  const startedAt = Date.now();

  emitStatus(terminal, deps, 'waiting');
  emitDetail(terminal, deps, 'waiting_ready');

  let prevCapture = null;
  let lastClass = 'boot';

  const poll = async () => {
    if (!alive(terminal) || terminal._delivering) return;
    const capture = await deps.tmuxCapturePane(name);
    if (!alive(terminal) || terminal._delivering) return;

    lastClass = classifyClaudeScreen(capture);

    if (lastClass === 'dialog') {
      emitStatus(terminal, deps, 'failed');
      emitDetail(terminal, deps, 'blocked_on_dialog');
      return; // leave session for human takeover — never paste into a dialog
    }

    if (lastClass === 'input' && inputRegionStable(prevCapture, capture)) {
      await deliver(terminal, deps, name, sanitized);
      return;
    }

    prevCapture = capture;

    if (Date.now() - startedAt >= capMs) {
      await onCap(terminal, deps, name, sanitized, lastClass);
      return;
    }
    deps.setTimeout(poll, POLL_INTERVAL_MS);
  };

  deps.setTimeout(poll, POLL_INTERVAL_MS);
}

async function onCap(terminal, deps, name, sanitized, lastClass) {
  if (lastClass === 'input') {
    await deliver(terminal, deps, name, sanitized);
    return;
  }
  emitStatus(terminal, deps, 'failed');
  emitDetail(terminal, deps, lastClass === 'dialog' ? 'blocked_on_dialog' : 'gave_up_at_cap');
}

async function deliver(terminal, deps, name, sanitized) {
  // Synchronously claim delivery BEFORE any await so poll / cap / restart
  // cannot double-deliver.
  if (terminal._delivering) return;
  terminal._delivering = true;
  terminal._pendingPrompt = null;

  emitStatus(terminal, deps, 'injecting');

  if (!sanitized) {
    emitStatus(terminal, deps, 'failed');
    emitDetail(terminal, deps, 'gave_up_at_cap');
    return;
  }

  try {
    let marker = null;
    for (let attempt = 0; attempt <= MAX_PASTE_RETRIES && !marker; attempt++) {
      if (attempt > 0) emitDetail(terminal, deps, 'retry');
      await deps.tmuxClearInput(name);
      await deps.tmuxPasteStdin(name, sanitized);
      const capture = await deps.tmuxCapturePane(name);
      marker = landedMarker(capture, sanitized);
    }

    if (!marker) {
      // Never submit an unverified / possibly-partial buffer.
      emitStatus(terminal, deps, 'failed');
      emitDetail(terminal, deps, 'gave_up_at_cap');
      return;
    }

    const submitted = await deps.tmuxSendEnter(name);
    const postEnter = await deps.tmuxCapturePane(name);
    const composerCleared = !(inputRegion(postEnter) || postEnter).includes(marker);

    if (submitted && composerCleared) {
      // Enter succeeded AND the composer no longer shows the paste → turn started.
      emitStatus(terminal, deps, 'done');
      emitDetail(terminal, deps, 'delivered_submitted');
      return;
    }

    // Enter failed, or the pasted content is still in the composer (turn never
    // started). The content already sits in the composer, so re-injecting would
    // double it — do NOT fall through to the PTY-write path. Mark and stop.
    emitStatus(terminal, deps, 'failed');
    emitDetail(terminal, deps, 'delivered_unverified');
  } catch {
    // Hard tmux-exec failure only: flagged PTY-write last resort.
    emitDetail(terminal, deps, 'fallback_pty_write');
    terminal._pendingPrompt = sanitized;
    terminal._delivering = false;
    try { await deps.injectPrompt(terminal); } catch {}
    emitDetail(terminal, deps, 'delivered_unverified');
  }
}

function alive(terminal) {
  return !!terminal.ptyProcess;
}
