import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { saveTerminalToDb, archiveSession } from './state.mjs';
import { termEventLogPath, isPidAlive } from './utils.mjs';
import { EventStream } from './event-stream.mjs';
import * as db from './db.mjs';
import { stripAnsi } from './lib/ansi.mjs';

export const terminalEvents = new EventEmitter();

// Shared terminal handler wiring (used for fresh spawn and restore)
export function wireTerminalHandlers(terminal) {
  terminal.ptyProcess.on('error', (err) => {
    console.error(JSON.stringify({
      type: 'pty_error',
      errno: err.code,
      message: err.message,
      pid: terminal.ptyProcess?.pid,
      session_id: terminal.id,
      timestamp: new Date().toISOString(),
    }));
  });

  terminal.ptyProcess.onData((data) => {
    // Append to EventStream
    const event = terminal.eventStream.append('data', data);

    // Write to JSONL log
    try {
      appendFileSync(termEventLogPath(terminal.id), JSON.stringify(event) + '\n');
    } catch {}

    // Broadcast to all WS subscribers
    terminal.eventStream.broadcast(event);

    // Check for Claude session ID (if not already found)
    if (!terminal.claude_session_id && terminal._adapter) {
      const sessionId = terminal._adapter.extractSessionId(terminal._accumulated || '', data);
      if (sessionId) {
        terminal.claude_session_id = sessionId;
        terminal._accumulated = '';
        db.updateTerminalClaudeSessionId(terminal.id, sessionId).catch(e => console.error('[pty] updateTerminalClaudeSessionId:', e.message));
        // Emit meta event
        const metaEvent = terminal.eventStream.append('meta', { key: 'claude_session_id', value: sessionId });
        try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(metaEvent) + '\n'); } catch {}
        terminal.eventStream.broadcast(metaEvent);
      } else {
        terminal._accumulated = ((terminal._accumulated || '') + data).slice(-4096);
      }
    }

    // Readiness detection for prompt injection (non-tmux only).
    // tmux sessions are driven by the capture-based state machine in
    // injection/index.mjs — the early pre-mount ?2004h must NOT trigger a blind
    // PTY write here, or the paste lands before Ink mounts and is discarded.
    if (!terminal.tmux_session && terminal._pendingPrompt && !terminal._readyForPrompt && terminal._adapter) {
      if (terminal._adapter.detectReadiness(terminal._accumulated || '', data)) {
        terminal._readyForPrompt = true;
        const delay = terminal._adapter.injectionDelay ?? 0;
        if (delay > 0) {
          setTimeout(() => injectPrompt(terminal), delay);
        } else {
          injectPrompt(terminal);
        }
      }
    }
  });

  terminal.ptyProcess.onExit(({ exitCode }) => {
    terminal.status = exitCode === 0 ? 'completed' : 'failed';
    terminal.exited_at = new Date().toISOString();

    // Emit meta exit event
    const exitEvent = terminal.eventStream.append('meta', { key: 'status', value: terminal.status });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(exitEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(exitEvent);

    // Broadcast exit to all subscribers
    const exitMsg = JSON.stringify({ type: 'exit', code: exitCode });
    for (const [, sub] of terminal.eventStream.subscribers) {
      try { sub.ws.send(exitMsg); } catch {}
    }
    terminal.eventStream.subscribers.clear();
    try { terminalEvents.emit('exit', terminal); } catch {}

    terminal.ptyProcess = null;
    if (terminal.tmux_session) {
      try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
    }
    archiveSession(terminal, 'terminal').catch(e => console.error('[onExit] archiveSession:', e.message));
    saveTerminalToDb(terminal).catch(e => console.error('[onExit] saveTerminalToDb:', e.message));
    // Keep terminal in memory for frontend display; auto-cleanup timer handles removal after 10min
  });
}

// Strip ESC-led sequences (CSI, OSC, etc.) and standalone BEL/BS control codes.
// These are interpreted by the PTY terminal driver rather than inserted as text,
// causing character mangling around adjacent multibyte characters.
const sanitizePrompt = stripAnsi;

export async function injectPrompt(terminal) {
  if (!terminal._pendingPrompt || !terminal.ptyProcess) return;
  const prompt = terminal._pendingPrompt;
  terminal._pendingPrompt = null;

  // Emit injection starting meta event
  const startEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'injecting' });
  try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(startEvent) + '\n'); } catch {}
  terminal.eventStream.broadcast(startEvent);

  try {
    // Bracketed paste delivery — zero-delay chunked writes.
    //
    // Sanitize first to strip ANSI sequences the PTY driver would interpret as control codes.
    // Chunk by Unicode code points (not UTF-16 code units) to prevent surrogate pair splits.
    // CHUNK_SIZE=512 stays below the macOS PTY kernel buffer (1024 bytes), keeping each
    // write() syscall kernel-atomic on Darwin. All writes are synchronous (no await),
    // so the event loop never yields between chunks — Ink's input handler cannot interleave.
    // W-1249: removing the 100ms inter-chunk delay was the root cause of prompt scattering.
    const sanitized = sanitizePrompt(prompt);
    if (!sanitized) return;
    const codePoints = [...sanitized];
    const CHUNK_SIZE = 512;
    terminal.ptyProcess.write('\x1b[200~');
    for (let i = 0; i < codePoints.length; i += CHUNK_SIZE) {
      terminal.ptyProcess.write(codePoints.slice(i, i + CHUNK_SIZE).join(''));
    }
    terminal.ptyProcess.write('\x1b[201~\r');

    // Emit done meta event
    const doneEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'done' });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(doneEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(doneEvent);
  } catch {
    const failEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'failed' });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(failEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(failEvent);

    // Emit session_status: failed before killing so the frontend sees it immediately.
    // _pendingPrompt is already null (cleared above) — re-entrancy guard prevents onExit
    // from re-entering injectPrompt if it fires synchronously during the kill sequence.
    const statusEvent = terminal.eventStream.append('meta', { key: 'session_status', value: 'failed' });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(statusEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(statusEvent);

    // Three-step kill sequence matching routes/terminal.mjs.
    // For tmux sessions, ptyProcess is only the attach client — the tmux session itself
    // must also be killed to stop the actual agent process.
    const ptyProc = terminal.ptyProcess;
    if (ptyProc) {
      try { ptyProc.kill('SIGHUP'); } catch {}
    }
    if (terminal.tmux_session) {
      try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
    }
    if (terminal.pid && isPidAlive(terminal.pid)) {
      try { process.kill(terminal.pid, 'SIGTERM'); } catch {}
    }
  }
}

export async function injectIntoTerminal(terminal, prompt) {
  if (!terminal || terminal.status !== 'running') return { ok: false, reason: 'not_running' };
  if (terminal._pendingPrompt) return { ok: false, reason: 'busy' };
  terminal._pendingPrompt = prompt;
  terminal._readyForPrompt = true;
  await injectPrompt(terminal);
  return { ok: true };
}
