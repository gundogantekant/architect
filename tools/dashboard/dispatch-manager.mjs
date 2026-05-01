import { readFileSync, existsSync, createWriteStream, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath, sleep } from './utils.mjs';
import { PORTFOLIO, WORK, LOGS_DIR, TMUX_AVAILABLE } from './constants.mjs';
import * as db from './db.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';
import pty from 'node-pty';

// --- Project sync from portfolio registry ---
export async function syncProjectsFromRegistry() {
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
    await db.upsertProject({ key, org: entry.org, project: entry.project, component: entry.component, path, role });
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
    // Populate lastLines preview and derive agent_phase from replayed events
    let replayPhase = 'generating';
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        replayPhase = derivePhase(replayPhase, evt);
        const text = extractStreamText(evt);
        if (text) {
          dispatch.lastLines.push(text);
          if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
        }
      } catch {}
    }
    dispatch.agent_phase = replayPhase;
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
      saveDispatchToDb(dispatch).catch(e => console.error('[tail] saveDispatchToDb:', e.message));
      archiveSession(dispatch, 'dispatch').catch(e => console.error('[tail] archiveSession:', e.message));
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
          const newPhase = derivePhase(dispatch.agent_phase, evt);
          if (newPhase !== dispatch.agent_phase) {
            dispatch.agent_phase = newPhase;
          }
          const text = extractStreamText(evt);
          if (text) {
            dispatch.lastLines.push(text);
            if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
          }
          if (evt.type === 'result' && evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveDispatchToDb(dispatch).catch(e => console.error('[tail] saveDispatchToDb (cost):', e.message));
          }
        } catch {}
        broadcastDispatchLine(dispatch, line);
      }
    } catch {}
  }, 2000);
  dispatch._tailInterval = interval;
}

// Restore persisted sessions from PostgreSQL with PID liveness checks
export async function restoreSessions(wireTerminalHandlers, deps) {
  // Mark legacy rows (no PID) as interrupted
  await db.markRunningAsInterrupted();

  const now = new Date().toISOString();
  let reconnectedDispatches = 0;
  let interruptedDispatches = 0;
  let reconnectedTerminals = 0;
  let interruptedTerminals = 0;

  for (const d of await db.getPersistedDispatches()) {
    if (d.status === 'merge_pending') {
      const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
      let output = [];
      try { output = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()); } catch {}
      const dispatch = {
        ...d,
        output,
        lastLines: [],
        wsClients: new Set(),
        process: null,
        _mergeHandled: true,
      };
      dispatches.set(d.id, dispatch);
      const mergeGate = (await db.getPreference('merge_gate')) ?? 'confirm';
      if (mergeGate === 'auto') {
        setImmediate(() => triggerMerge(dispatch, deps));
      }
      // 'confirm' mode: surface in UI, user triggers manually via POST /api/dispatch/:id/merge
      continue;
    }
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
        // PID dead — mark interrupted, archive to session_history, load log content for display
        interruptedDispatches++;
        d.status = 'interrupted';
        d.completed_at = now;
        await db.updateDispatchStatus(d.id, 'interrupted', now);
        archiveSession(d, 'dispatch').catch(e => console.error('[restore] archiveSession dispatch:', e.message));
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

  const persistedTerminals = await db.getPersistedTerminals();
  const BATCH_SIZE = 5;
  const BATCH_DELAY_MS = 100;

  for (let batchStart = 0; batchStart < persistedTerminals.length; batchStart += BATCH_SIZE) {
    if (batchStart > 0) await sleep(BATCH_DELAY_MS);
    const batch = persistedTerminals.slice(batchStart, batchStart + BATCH_SIZE);

    for (const t of batch) {
      const eventLogPath = termEventLogPath(t.id);
      let eventStream;
      if (existsSync(eventLogPath)) {
        const content = readFileSync(eventLogPath, 'utf8');
        eventStream = EventStream.fromJSONL(content, t.id);
      } else {
        eventStream = new EventStream(t.id);
      }

      if (t.status === 'suspended') {
        terminals.set(t.id, {
          ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
          cols: t.cols || 80, rows: t.rows || 24,
        });
        continue;
      }

      if (t.status === 'running') {
        if (t.tmux_session && TMUX_AVAILABLE && tmuxSessionExists(t.tmux_session)) {
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
            interruptedTerminals++;
            t.status = 'interrupted';
            t.exited_at = now;
            await db.updateTerminalStatus(t.id, 'interrupted', now);
            archiveSession(t, 'terminal').catch(err => console.error('[restore] archiveSession terminal:', err.message));
            terminals.set(t.id, {
              ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
              cols: t.cols || 80, rows: t.rows || 24,
            });
          }
        } else if (t.pid && isPidAlive(t.pid)) {
          reconnectedTerminals++;
          terminals.set(t.id, {
            ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
            alive_but_detached: true, cols: t.cols || 80, rows: t.rows || 24,
          });
          console.log(`Terminal ${t.id}: PID ${t.pid} alive but no tmux — marked as detached`);
        } else {
          interruptedTerminals++;
          t.status = 'interrupted';
          t.exited_at = now;
          await db.updateTerminalStatus(t.id, 'interrupted', now);
          archiveSession(t, 'terminal').catch(err => console.error('[restore] archiveSession terminal:', err.message));
          terminals.set(t.id, {
            ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
            cols: t.cols || 80, rows: t.rows || 24,
          });
        }
      } else {
        terminals.set(t.id, {
          ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
          cols: t.cols || 80, rows: t.rows || 24,
        });
      }
    }
  }

  for (const c of await db.getPersistedCliSessions()) {
    if (c.status === 'running' && isPidAlive(c.pid)) {
      cliSessions.set(c.id, { ...c });
    } else {
      // Dead or exited CLI session — archive then clean up
      if (!c.exited_at) c.exited_at = now;
      archiveSession(c, 'cli').catch(e => console.error('[restore] archiveSession cli:', e.message));
      await db.deleteCliSession(c.id);
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

// Derive the next agent phase from current phase and a stream-json event.
// Pure function — no side effects. Used by both live parsing and log replay.
// Seed with 'generating' for new dispatches.
export function derivePhase(currentPhase, evt) {
  if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use')
    return 'tool_running';
  if (evt.type === 'assistant' && evt.message?.stop_reason === 'end_turn')
    return 'waiting_for_input';
  if (evt.type === 'assistant' && evt.message?.stop_reason === 'tool_use')
    return 'tool_running';
  if (currentPhase === 'tool_running' && (
    (evt.type === 'content_block_start' && evt.content_block?.type === 'text') ||
    (evt.type === 'content_block_delta' && evt.delta?.text)
  ))
    return 'generating';
  if (evt.type === 'result')
    return null;
  return currentPhase;
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
          saveDispatchToDb(dispatch).catch(e => console.error('[dispatch] saveDispatchToDb (session_id):', e.message));
        }
        if (evt.type === 'result' && evt.total_cost_usd != null) {
          dispatch.cost_usd = evt.total_cost_usd;
          saveDispatchToDb(dispatch).catch(e => console.error('[dispatch] saveDispatchToDb (cost):', e.message));
        }
        const newPhase = derivePhase(dispatch.agent_phase, evt);
        if (newPhase !== dispatch.agent_phase) {
          dispatch.agent_phase = newPhase;
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
    if (dispatch._mergeHandled) {
      // Agent called POST /complete before exiting — status already set to merge_pending.
      // Do not overwrite status. Just clean up streams and persist.
      dispatch.process = null;
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      saveDispatchToDb(dispatch).catch(e => console.error('[dispatch close] saveDispatchToDb (merge_pending):', e.message));
      return;
    }
    dispatch.status = code === 0 ? 'completed' : 'failed';
    if (code === 0 && dispatch.dispatch_mode === 'auto_implement') {
      dispatch._exitedWithoutSignal = true;
    }
    dispatch.completed_at = new Date().toISOString();
    dispatch.process = null;
    if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
    if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
    broadcastDispatchDone(dispatch);
    archiveSession(dispatch, 'dispatch').catch(e => console.error('[dispatch close] archiveSession:', e.message));
    saveDispatchToDb(dispatch).catch(e => console.error('[dispatch close] saveDispatchToDb:', e.message));
    // Keep dispatch in memory for frontend display; auto-cleanup timer handles removal after 30min
  });
}

/**
 * Execute the merge-back step for an auto-implement dispatch that has signalled completion.
 * Called by POST /api/dispatch/:id/merge (UI-triggered) and by restoreSessions (restart recovery).
 *
 * @param {Object} dispatch - the in-memory dispatch record
 * @param {Object} deps - server deps including attemptMerge and db
 */
export async function triggerMerge(dispatch, deps) {
  const { attemptMerge, db: depsDb = db } = deps;

  const result = await attemptMerge({
    dispatchId: dispatch.id,
    worktreePath: dispatch.worktree_path,
    sourceBranch: dispatch.source_branch,
    projectPath: dispatch.project_path,
  });

  const now = new Date().toISOString();

  if (result.success) {
    dispatch.status = 'completed';
    dispatch.merge_result = 'success';
    dispatch.completed_at = now;
    await depsDb.updateDispatchMergeResult(dispatch.id, {
      status: 'completed',
      completed_at: now,
      merge_result: 'success',
    });
    if (dispatch.work_item_id) {
      await depsDb.updateWorkItem(dispatch.work_item_id, { status: 'done' });
    }
    await saveDispatchToDb(dispatch);
    broadcastDispatchDone(dispatch);
  } else {
    dispatch.status = 'merge_conflict';
    dispatch.merge_result = 'conflict';
    dispatch.completed_at = now;
    await depsDb.updateDispatchMergeResult(dispatch.id, {
      status: 'merge_conflict',
      completed_at: now,
      merge_result: 'conflict',
    });
    await saveDispatchToDb(dispatch);
    broadcastDispatchDone(dispatch);
  }
}
