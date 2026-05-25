import { appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { saveTerminalToDb, archiveSession } from './state.mjs';
import { termEventLogPath, sleep } from './utils.mjs';
import { EventStream } from './event-stream.mjs';
import * as db from './db.mjs';

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

    // Readiness detection for prompt injection
    if (terminal._pendingPrompt && !terminal._readyForPrompt && terminal._adapter) {
      if (terminal._adapter.detectReadiness(terminal._accumulated || '', data)) {
        terminal._readyForPrompt = true;
        injectPrompt(terminal);
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

    terminal.ptyProcess = null;
    if (terminal.tmux_session) {
      try { execFileSync('tmux', ['kill-session', '-t', terminal.tmux_session], { stdio: 'ignore' }); } catch {}
    }
    archiveSession(terminal, 'terminal').catch(e => console.error('[onExit] archiveSession:', e.message));
    saveTerminalToDb(terminal).catch(e => console.error('[onExit] saveTerminalToDb:', e.message));
    // Keep terminal in memory for frontend display; auto-cleanup timer handles removal after 10min
  });
}

function sanitizePrompt(raw) {
  // Strip ESC-led sequences (CSI, OSC, etc.) and standalone BEL/BS control codes.
  // These are interpreted by the PTY terminal driver rather than inserted as text,
  // causing character mangling around adjacent multibyte characters.
  // Process longest sequences first so prefix matches don't leave residue.
  return raw
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '')          // CSI: ESC[ params final-byte
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')       // OSC: ESC] content ST/BEL
    .replace(/\x1b[\x20-\x7e]/g, '')                         // 2-char ESC sequences
    .replace(/\x1b/g, '')                                    // any remaining lone ESC
    .replace(/[\x07\x08]/g, '');                             // standalone BEL and BS
}

export async function injectPrompt(terminal) {
  if (!terminal._pendingPrompt || !terminal.ptyProcess) return;
  const prompt = terminal._pendingPrompt;
  terminal._pendingPrompt = null;

  // Emit injection starting meta event
  const startEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'injecting' });
  try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(startEvent) + '\n'); } catch {}
  terminal.eventStream.broadcast(startEvent);

  try {
    // Bracketed paste mode chunked delivery.
    // Sanitize first to strip ANSI sequences that the PTY would interpret as control codes.
    // Chunk by Unicode code points (not UTF-16 code units) to prevent surrogate pair splits.
    const sanitized = sanitizePrompt(prompt);
    const codePoints = [...sanitized];
    const CHUNK_SIZE = 1024;
    const CHUNK_DELAY = 100;
    terminal.ptyProcess.write('\x1b[200~');
    for (let i = 0; i < codePoints.length; i += CHUNK_SIZE) {
      const chunk = codePoints.slice(i, i + CHUNK_SIZE).join('');
      try { terminal.ptyProcess.write(chunk); } catch {}
      if (i + CHUNK_SIZE < codePoints.length) await sleep(CHUNK_DELAY);
    }
    terminal.ptyProcess.write('\x1b[201~');
    terminal.ptyProcess.write('\r');

    // Emit done meta event
    const doneEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'done' });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(doneEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(doneEvent);
  } catch {
    const failEvent = terminal.eventStream.append('meta', { key: 'prompt_injection_status', value: 'failed' });
    try { appendFileSync(termEventLogPath(terminal.id), JSON.stringify(failEvent) + '\n'); } catch {}
    terminal.eventStream.broadcast(failEvent);
  }
}
