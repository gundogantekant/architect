import { readFileSync, existsSync, createWriteStream, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath } from './utils.mjs';
import { PORTFOLIO, WORK, LOGS_DIR, TMUX_AVAILABLE } from './constants.mjs';
import * as db from './db.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';
import pty from 'node-pty';

// --- Project sync from portfolio registry ---
export function syncProjectsFromRegistry() {
  const registryPath = join(PORTFOLIO, 'registry.json');
  if (!existsSync(registryPath)) return 0;
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  let count = 0;
  for (const [path, entry] of Object.entries(registry.entries || {})) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    let role = '';
    try {
      const comp = JSON.parse(readFileSync(join(PORTFOLIO, entry.org, entry.project, `${entry.component}.json`), 'utf8'));
      role = comp.role || '';
    } catch {}
    db.upsertProject({ key, org: entry.org, project: entry.project, component: entry.component, path, role });
    count++;
  }
  if (count) console.log(`Synced ${count} projects from portfolio registry`);
  return count;
}

// Broadcast a JSONL line to all dispatch WebSocket clients
export function broadcastDispatchLine(dispatch, line) {
  const msg = JSON.stringify({ type: 'data', data: line });
  for (const ws of dispatch.wsClients) {
    try { ws.send(msg); } catch {}
  }
}

// Broadcast done + close all dispatch WebSocket clients
export function broadcastDispatchDone(dispatch) {
  const msg = JSON.stringify({ type: 'done', status: dispatch.status });
  for (const ws of dispatch.wsClients) {
    try { ws.send(msg); ws.close(); } catch {}
  }
  dispatch.wsClients.clear();
}

// Tail a log file for a reconnected dispatch (PID alive but no process handle)
export function tailLogFile(dispatch) {
  let offset = 0;
  // Read existing lines for initial offset
  try {
    const content = readFileSync(dispatch.logPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    offset = lines.length;
    // Populate output buffer from existing log
    dispatch.output = lines;
    // Populate lastLines preview
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        const text = extractStreamText(evt);
        if (text) {
          dispatch.lastLines.push(text);
          if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
        }
      } catch {}
    }
  } catch {}

  // Re-open log stream for any new output written by the orphaned process
  try {
    dispatch.logStream = createWriteStream(dispatch.logPath, { flags: 'a' });
  } catch {}

  const interval = setInterval(() => {
    if (!dispatch.pid || !isPidAlive(dispatch.pid)) {
      clearInterval(interval);
      dispatch._tailInterval = null;
      dispatch.status = 'interrupted';
      dispatch.completed_at = new Date().toISOString();
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      saveDispatchToDb(dispatch);
      broadcastDispatchDone(dispatch);
      return;
    }
    try {
      const content = readFileSync(dispatch.logPath, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const newLines = lines.slice(offset);
      offset = lines.length;
      for (const line of newLines) {
        dispatch.output.push(line);
        try {
          const evt = JSON.parse(line);
          const text = extractStreamText(evt);
          if (text) {
            dispatch.lastLines.push(text);
            if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
          }
          if (evt.type === 'result' && evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveDispatchToDb(dispatch);
          }
        } catch {}
        broadcastDispatchLine(dispatch, line);
      }
    } catch {}
  }, 2000);
  dispatch._tailInterval = interval;
}

// Restore persisted sessions from SQLite with PID liveness checks
export function restoreSessions(wireTerminalHandlers) {
  // Mark legacy rows (no PID) as interrupted
  db.markRunningAsInterrupted();

  const now = new Date().toISOString();
  let reconnectedDispatches = 0;
  let interruptedDispatches = 0;
  let reconnectedTerminals = 0;
  let interruptedTerminals = 0;

  for (const d of db.getPersistedDispatches()) {
    if (d.status === 'suspended') {
      // Suspended dispatches: load into memory as-is (no running process)
      dispatches.set(d.id, {
        ...d, output: [], lastLines: [], wsClients: new Set(), process: null,
      });
      continue;
    }
    if (d.status === 'running' && d.pid) {
      if (isPidAlive(d.pid)) {
        // Process survived restart — reconnect via log file tailing
        reconnectedDispatches++;
        const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
        const dispatch = {
          ...d,
          output: [],
          lastLines: [],
          wsClients: new Set(),
          process: null,
          logPath,
          logStream: null,
        };
        dispatches.set(d.id, dispatch);
        tailLogFile(dispatch);
        console.log(`Dispatch ${d.id}: PID ${d.pid} still alive, reconnecting via log tail`);
      } else {
        // PID dead — mark interrupted, load log content for display
        interruptedDispatches++;
        d.status = 'interrupted';
        d.completed_at = now;
        db.updateDispatchStatus(d.id, 'interrupted', now);
        const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
        let output = [];
        try { output = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()); } catch {}
        dispatches.set(d.id, {
          ...d, output, lastLines: [], wsClients: new Set(), process: null,
        });
      }
    } else {
      // Non-running dispatch (completed/failed/killed/interrupted) — load into memory with log content
      const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
      let output = [];
      try { output = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()); } catch {}
      dispatches.set(d.id, {
        ...d, output, lastLines: [], wsClients: new Set(), process: null,
      });
    }
  }

  for (const t of db.getPersistedTerminals()) {
    // Load EventStream from JSONL log
    const eventLogPath = termEventLogPath(t.id);
    let eventStream;
    if (existsSync(eventLogPath)) {
      const content = readFileSync(eventLogPath, 'utf8');
      eventStream = EventStream.fromJSONL(content, t.id);
    } else {
      eventStream = new EventStream(t.id);
    }

    if (t.status === 'suspended') {
      // Suspended terminals: load into memory as-is (no running process)
      terminals.set(t.id, {
        ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
        cols: t.cols || 80, rows: t.rows || 24,
      });
      continue;
    }

    if (t.status === 'running') {
      if (t.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(t.tmux_session)) {
        // Re-attach to tmux session
        reconnectedTerminals++;
        try {
          const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', t.tmux_session], {
            name: 'xterm-256color', cols: t.cols || 80, rows: t.rows || 24,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
          const terminal = {
            ...t,
            ptyProcess,
            eventStream,
            wsClients: eventStream.subscribers,
            cols: t.cols || 80,
            rows: t.rows || 24,
            _adapter: getAdapter(t.agent_type || 'claude'),
            _accumulated: '',
          };
          wireTerminalHandlers(terminal);
          terminals.set(t.id, terminal);
          console.log(`Terminal ${t.id}: tmux session ${t.tmux_session} re-attached`);
        } catch (e) {
          // tmux attach failed — mark interrupted
          interruptedTerminals++;
          t.status = 'interrupted';
          t.exited_at = now;
          db.updateTerminalStatus(t.id, 'interrupted', now);
          archiveSession(t, 'terminal');
          terminals.set(t.id, {
            ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
            cols: t.cols || 80, rows: t.rows || 24,
          });
        }
      } else if (t.pid && isPidAlive(t.pid)) {
        // PID alive but no tmux — alive but detached
        reconnectedTerminals++;
        terminals.set(t.id, {
          ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
          alive_but_detached: true, cols: t.cols || 80, rows: t.rows || 24,
        });
        console.log(`Terminal ${t.id}: PID ${t.pid} alive but no tmux — marked as detached`);
      } else {
        // Dead — mark interrupted
        interruptedTerminals++;
        t.status = 'interrupted';
        t.exited_at = now;
        db.updateTerminalStatus(t.id, 'interrupted', now);
        terminals.set(t.id, {
          ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
          cols: t.cols || 80, rows: t.rows || 24,
        });
      }
    } else {
      // Non-running terminal (completed/failed/killed/interrupted) — load into memory with EventStream
      terminals.set(t.id, {
        ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
        cols: t.cols || 80, rows: t.rows || 24,
      });
    }
  }

  for (const c of db.getPersistedCliSessions()) {
    if (c.status === 'running' && isPidAlive(c.pid)) {
      cliSessions.set(c.id, { ...c });
    } else {
      // Dead or exited CLI session — archive then clean up
      if (!c.exited_at) c.exited_at = now;
      archiveSession(c, 'cli');
      db.deleteCliSession(c.id);
    }
  }

  if (dispatches.size || terminals.size || cliSessions.size) {
    console.log(`Restored: ${dispatches.size} dispatches (${reconnectedDispatches} reconnected, ${interruptedDispatches} interrupted), ${terminals.size} terminals (${reconnectedTerminals} reconnected, ${interruptedTerminals} interrupted), ${cliSessions.size} CLI sessions`);
  }
  if (!TMUX_AVAILABLE) {
    console.log('Note: tmux not found — terminal sessions will not survive restarts. Install with: brew install tmux');
  }
}

export function extractStreamText(evt) {
  if (evt.type === 'assistant' && evt.message?.content) {
    return evt.message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  if (evt.type === 'content_block_delta' && evt.delta?.text) return evt.delta.text;
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use') return `▸ ${evt.content_block.name || 'tool'}`;
  if (evt.type === 'content_block_start' && evt.content_block?.text) return evt.content_block.text;
  if (evt.type === 'result') return `--- Agent finished ---`;
  return null;
}

export function killProcess(proc, signal = 'SIGTERM') {
  try { proc.kill(signal); } catch {}
}

export function killProcessGraceful(proc) {
  killProcess(proc, 'SIGTERM');
  return setTimeout(() => {
    try { proc.kill('SIGKILL'); } catch {}
  }, 5000);
}

// Shared dispatch process wiring: stdout/stderr parsing, log file writing, close handler
export function wireDispatchHandlers(dispatch, proc) {
  let buffer = '';
  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.session_id && !dispatch.claude_session_id) {
          dispatch.claude_session_id = evt.session_id;
          saveDispatchToDb(dispatch);
        }
        if (evt.type === 'result' && evt.total_cost_usd != null) {
          dispatch.cost_usd = evt.total_cost_usd;
          dispatch.needs_input = false;
          saveDispatchToDb(dispatch);
        }
        // Track needs_input: agent asked a question (end_turn) vs using tools (tool_use)
        if (evt.type === 'assistant' && evt.message?.stop_reason === 'end_turn') {
          dispatch.needs_input = true;
        } else if (evt.type === 'assistant' && evt.message?.stop_reason === 'tool_use') {
          dispatch.needs_input = false;
        }
        const text = extractStreamText(evt);
        if (text) {
          dispatch.lastLines.push(text);
          if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
        }
      } catch {}
      dispatch.output.push(line);
      if (dispatch.logStream) dispatch.logStream.write(line + '\n');
      broadcastDispatchLine(dispatch, line);
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = JSON.stringify({ type: 'stderr', content: chunk.toString() });
    dispatch.output.push(line);
    if (dispatch.logStream) dispatch.logStream.write(line + '\n');
    broadcastDispatchLine(dispatch, line);
  });

  proc.on('close', (code) => {
    dispatch.status = code === 0 ? 'completed' : 'failed';
    dispatch.completed_at = new Date().toISOString();
    dispatch.process = null;
    if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
    if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
    broadcastDispatchDone(dispatch);
    archiveSession(dispatch, 'dispatch');
    saveDispatchToDb(dispatch);
    // Keep dispatch in memory for frontend display; auto-cleanup timer handles removal after 30min
  });
}
