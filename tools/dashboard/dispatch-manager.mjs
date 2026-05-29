import { readFileSync, existsSync, createWriteStream, appendFileSync } from 'node:fs';
import { unlink as unlinkFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { applyRefinementSummary } from './lib/refine-apply.mjs';
import { validateOrgName } from './lib/portfolio-validation.mjs';
import { isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath, sleep } from './utils.mjs';
import { PORTFOLIO, WORK, LOGS_DIR, TMUX_AVAILABLE, TIMEOUT_WARNING_RATIO, IDLE_THRESHOLD_MS, MAX_AUTO_EXTENDS, EXTEND_DURATION_MS, INPUT_NEEDED_SOURCE } from './constants.mjs';
import * as db from './db.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';
import pty from 'node-pty';

// --- Project sync from portfolio registry ---
export async function syncProjectsFromRegistry() {
  const registryPath = join(PORTFOLIO, 'registry.json');
  if (!existsSync(registryPath)) return { count: 0, skippedEntries: [] };
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  let count = 0;
  const skippedEntries = [];
  for (const [path, entry] of Object.entries(registry.entries || {})) {
    const key = `${entry.org}/${entry.project}/${entry.component}`;
    const { ok, reason } = validateOrgName(entry.org);
    if (!ok) {
      console.error(`[syncProjectsFromRegistry] skipping registry entry — ${reason}:`, key);
      skippedEntries.push({ key, reason });
      continue;
    }
    let role = '';
    try {
      const comp = JSON.parse(readFileSync(join(PORTFOLIO, entry.org, entry.project, `${entry.component}.json`), 'utf8'));
      role = comp.role || '';
    } catch {}
    await db.upsertProject({ key, org: entry.org, project: entry.project, component: entry.component, path, role });
    count++;
  }
  if (count) console.log(`Synced ${count} projects from portfolio registry`);
  return { count, skippedEntries };
}

// Broadcast a JSONL line to all dispatch WebSocket clients
export function broadcastDispatchLine(dispatch, line) {
  dispatch.lastOutputAt = Date.now();
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

// Append a ProgressEvent to dispatch output and broadcast to active SSE clients
export function appendProgress(dispatch, event) {
  const line = JSON.stringify(event);
  dispatch.output.push(line);
  dispatch.lastProgressPhase = event.phase;
  broadcastDispatchLine(dispatch, line);
  if (dispatch.logStream) dispatch.logStream.write(line + '\n');
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
            const historyEntry = { phase: newPhase, at: new Date().toISOString() };
            dispatch.agent_phase_history = dispatch.agent_phase_history || [];
            dispatch.agent_phase_history = [...dispatch.agent_phase_history, historyEntry].slice(-50);
            dispatch.agent_phase = newPhase;
            db.updateAgentPhase(dispatch.id, newPhase, historyEntry).catch(err =>
              console.error(`[agent_phase] failed to persist phase ${newPhase} for ${dispatch.id}:`, err)
            );
            // # DECISION: Bridge agent waiting_for_input phase to work item input_needed flag.
            // Only set via bridge; only clear when source=bridge AND no other waiting dispatches.
            if (newPhase === 'waiting_for_input' && dispatch.work_item_id) {
              db.setInputNeeded(dispatch.work_item_id, true, 'agent_phase_bridge').catch(err =>
                console.error('[bridge] setInputNeeded failed:', err.message)
              );
            } else if (newPhase !== 'waiting_for_input' && dispatch.work_item_id) {
              db.setInputNeeded(dispatch.work_item_id, false, 'agent_phase_bridge').catch(err =>
                console.error('[bridge] clearInputNeeded failed:', err.message)
              );
            }
          }
          const text = extractStreamText(evt);
          if (text) {
            dispatch.lastLines.push(text);
            if (dispatch.lastLines.length > 5) dispatch.lastLines.shift();
          }
          if (evt.type === 'result') {
            if (evt.total_cost_usd != null) {
              dispatch.cost_usd = evt.total_cost_usd;
              saveDispatchToDb(dispatch).catch(e => console.error('[tail] saveDispatchToDb (cost):', e.message));
            }
            const usage = evt.usage || {};
            if (usage.input_tokens != null || usage.output_tokens != null) {
              db.insertDispatchCost({
                id: dispatch.id,
                model: evt.model || null,
                agentRole: dispatch.agent_role || null,
                inputTokens: usage.input_tokens || 0,
                outputTokens: usage.output_tokens || 0,
                cacheReadTokens: usage.cache_read_input_tokens || 0,
                cacheWriteTokens: usage.cache_creation_input_tokens || 0,
              }).catch(e => console.error('[cost] insertDispatchCost (tail):', e.message));
            }
          }
        } catch {}
        broadcastDispatchLine(dispatch, line);
      }
    } catch {}
  }, 2000);
  dispatch._tailInterval = interval;
}

// Hard-kill a running dispatch after its timeout window expires.
function killOnTimeout(dispatch, saveDispatch) {
  if (dispatch.status !== 'running') return;
  console.log(`[timeout] dispatch ${dispatch.id} hard kill after timeout`);
  dispatch._timedOut = true;
  dispatch.status = 'failed';
  dispatch.completed_at = new Date().toISOString();
  if (dispatch.process) {
    try { dispatch.process.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { dispatch.process?.kill('SIGKILL'); } catch {} }, 6000);
  }
  if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
  saveDispatch(dispatch).catch(e => console.error('[timeout] saveDispatch:', e.message));
}

// Schedule the two-phase soft timeout for a new dispatch.
// Phase 1 (at TIMEOUT_WARNING_RATIO of the window): auto-extend if active, set input_needed if idle.
// Phase 2 (at 100% of original window, or EXTEND_DURATION_MS after auto-extend): hard kill.
export function scheduleDispatchTimeout(dispatch, timeoutMs, saveDispatch) {
  dispatch.timeout_at = new Date(Date.now() + timeoutMs).toISOString();

  if (dispatch._autoExtended) {
    // Already auto-extended once (loaded from persisted state after restart); arm hard-kill only.
    dispatch._timeoutHandle = setTimeout(() => killOnTimeout(dispatch, saveDispatch), timeoutMs);
    return;
  }

  const warningMs = Math.floor(timeoutMs * TIMEOUT_WARNING_RATIO);

  dispatch._warningHandle = setTimeout(() => {
    dispatch._warningHandle = null;
    if (dispatch.status !== 'running') return;

    const isActive = (
      (dispatch.lastOutputAt && (Date.now() - dispatch.lastOutputAt) < IDLE_THRESHOLD_MS) ||
      dispatch.agent_phase === 'tool_running'
    );

    if (isActive && !dispatch._autoExtended) {
      dispatch._autoExtended = true;  // synchronous before any await

      // Cancel original hard-kill timer, arm extended timer
      if (dispatch._timeoutHandle) { clearTimeout(dispatch._timeoutHandle); dispatch._timeoutHandle = null; }
      dispatch.timeout_at = new Date(Date.now() + EXTEND_DURATION_MS).toISOString();
      dispatch._timeoutHandle = setTimeout(() => killOnTimeout(dispatch, saveDispatch), EXTEND_DURATION_MS);

      saveDispatch(dispatch).catch(e => console.error('[timeout-extend] saveDispatch:', e.message));

      const logEntry = { trigger: 'auto-extend', summary: `Auto-extended 30 min at 80%. New deadline: ${dispatch.timeout_at}`, detected_at: new Date().toISOString() };
      dispatch.session_log = dispatch.session_log || [];
      dispatch.session_log.push(logEntry);
      console.log(`[timeout] dispatch ${dispatch.id} auto-extended 30 min (active)`);

      const msg = JSON.stringify({ type: 'timeout_warning', event: 'auto_extended', timeout_at: dispatch.timeout_at, dispatch_id: dispatch.id });
      for (const ws of dispatch.wsClients) { try { ws.send(msg); } catch {} }
    } else {
      // Idle path — set input_needed, let original timer run to hard-kill
      if (dispatch.work_item_id) {
        db.setInputNeeded(dispatch.work_item_id, true, INPUT_NEEDED_SOURCE.TIMEOUT, 'Approaching timeout — agent appears idle. Extend or kill from the dashboard.').catch(err =>
          console.error('[timeout-idle] setInputNeeded:', err.message)
        );
      }
      const msg = JSON.stringify({ type: 'timeout_warning', event: 'idle', timeout_at: dispatch.timeout_at, dispatch_id: dispatch.id });
      for (const ws of dispatch.wsClients) { try { ws.send(msg); } catch {} }
      console.log(`[timeout] dispatch ${dispatch.id} idle at 80% — input_needed set, hard kill pending`);
    }
  }, warningMs);

  // Arm hard-kill at 100% of original window
  dispatch._timeoutHandle = setTimeout(() => killOnTimeout(dispatch, saveDispatch), timeoutMs);
}

// Re-arm the auto-timeout for a reconnected running dispatch after server restart.
// If timeout_at is already past, marks the dispatch as failed immediately.
// On restart we cannot reconstruct the original window, so we always arm hard-kill only.
function rearmDispatchTimeout(dispatch) {
  if (!dispatch.timeout_at) return;
  const remainingMs = new Date(dispatch.timeout_at).getTime() - Date.now();
  if (remainingMs <= 0) {
    dispatch.status = 'failed';
    dispatch.completed_at = new Date().toISOString();
    saveDispatchToDb(dispatch).catch(() => {});
    return;
  }
  dispatch._timeoutHandle = setTimeout(() => {
    if (dispatch.status !== 'running') return;
    dispatch._timedOut = true;
    dispatch.status = 'failed';
    dispatch.completed_at = new Date().toISOString();
    if (dispatch.process) {
      try { dispatch.process.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { dispatch.process?.kill('SIGKILL'); } catch {} }, 6000);
    }
    saveDispatchToDb(dispatch).catch(() => {});
  }, remainingMs);
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
    if (d.status === 'dismissed' || d.status === 'superseded') {
      // Dismissed/superseded: user-acknowledged terminal states — load into memory
      // with no log tail, no reconnect attempt. No recovery banner shown for these.
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
        rearmDispatchTimeout(dispatch);
        console.log(`Dispatch ${d.id}: PID ${d.pid} still alive, reconnecting via log tail`);
      } else {
        // PID dead — mark interrupted, archive to session_history, load log content for display
        interruptedDispatches++;
        d.status = 'interrupted';
        d.completed_at = now;
        await db.updateDispatchStatus(d.id, 'interrupted', now);
        await archiveSession(d, 'dispatch').catch(e => console.error('[restore] archiveSession dispatch:', e.message));
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

  for (const [, d] of dispatches) {
    if (d.agent_phase === 'waiting_for_input' && d.work_item_id && d.status === 'running') {
      db.setInputNeeded(d.work_item_id, true, 'agent_phase_bridge').catch(e =>
        console.error('[restore-bridge]', e.message)
      );
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
          _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
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
              _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
            };
            wireTerminalHandlers(terminal);
            terminals.set(t.id, terminal);
            console.log(`Terminal ${t.id}: tmux session ${t.tmux_session} re-attached`);
          } catch (e) {
            interruptedTerminals++;
            t.status = 'interrupted';
            t.exited_at = now;
            await db.updateTerminalStatus(t.id, 'interrupted', now);
            await archiveSession(t, 'terminal').catch(err => console.error('[restore] archiveSession terminal:', err.message));
            terminals.set(t.id, {
              ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
              cols: t.cols || 80, rows: t.rows || 24,
              _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
            });
          }
        } else if (t.pid && isPidAlive(t.pid)) {
          reconnectedTerminals++;
          terminals.set(t.id, {
            ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
            alive_but_detached: true, cols: t.cols || 80, rows: t.rows || 24,
            _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
          });
          console.log(`Terminal ${t.id}: PID ${t.pid} alive but no tmux — marked as detached`);
        } else {
          interruptedTerminals++;
          t.status = 'interrupted';
          t.exited_at = now;
          await db.updateTerminalStatus(t.id, 'interrupted', now);
          await archiveSession(t, 'terminal').catch(err => console.error('[restore] archiveSession terminal:', err.message));
          terminals.set(t.id, {
            ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
            cols: t.cols || 80, rows: t.rows || 24,
            _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
          });
        }
      } else {
        terminals.set(t.id, {
          ...t, ptyProcess: null, eventStream, wsClients: eventStream.subscribers,
          cols: t.cols || 80, rows: t.rows || 24,
          _goalSummarized: !!t.title,  // title already in DB → skip re-summarization on next input
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
      await archiveSession(c, 'cli').catch(e => console.error('[restore] archiveSession cli:', e.message));
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
        if (evt.type === 'result') {
          if (evt.total_cost_usd != null) {
            dispatch.cost_usd = evt.total_cost_usd;
            saveDispatchToDb(dispatch).catch(e => console.error('[dispatch] saveDispatchToDb (cost):', e.message));
          }
          const usage = evt.usage || {};
          if (usage.input_tokens != null || usage.output_tokens != null) {
            db.insertDispatchCost({
              id: dispatch.id,
              model: evt.model || null,
              agentRole: dispatch.agent_role || null,
              inputTokens: usage.input_tokens || 0,
              outputTokens: usage.output_tokens || 0,
              cacheReadTokens: usage.cache_read_input_tokens || 0,
              cacheWriteTokens: usage.cache_creation_input_tokens || 0,
            }).catch(e => console.error('[cost] insertDispatchCost:', e.message));
          }
        }
        const newPhase = derivePhase(dispatch.agent_phase, evt);
        if (newPhase !== dispatch.agent_phase) {
          const historyEntry = { phase: newPhase, at: new Date().toISOString() };
          dispatch.agent_phase_history = dispatch.agent_phase_history || [];
          dispatch.agent_phase_history = [...dispatch.agent_phase_history, historyEntry].slice(-50);
          dispatch.agent_phase = newPhase;
          db.updateAgentPhase(dispatch.id, newPhase, historyEntry).catch(err =>
            console.error(`[agent_phase] failed to persist phase ${newPhase} for ${dispatch.id}:`, err)
          );
          // # DECISION: Bridge agent waiting_for_input phase to work item input_needed flag.
          // Only set via bridge; only clear when source=bridge AND no other waiting dispatches.
          if (newPhase === 'waiting_for_input' && dispatch.work_item_id) {
            db.setInputNeeded(dispatch.work_item_id, true, 'agent_phase_bridge').catch(err =>
              console.error('[bridge] setInputNeeded failed:', err.message)
            );
          } else if (newPhase !== 'waiting_for_input' && dispatch.work_item_id) {
            db.setInputNeeded(dispatch.work_item_id, false, 'agent_phase_bridge').catch(err =>
              console.error('[bridge] clearInputNeeded failed:', err.message)
            );
          }
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

  proc.stdout.on('end', () => {
    if (buffer.trim()) {
      try {
        JSON.parse(buffer.trim()); // validate parseable before accepting
        const rawLine = buffer.trim();
        dispatch.output.push(rawLine);
        if (dispatch.logStream) dispatch.logStream.write(rawLine + '\n');
        broadcastDispatchLine(dispatch, rawLine);
      } catch (e) {
        // silently skip unparseable trailing content
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const line = JSON.stringify({ type: 'stderr', content: chunk.toString() });
    dispatch.output.push(line);
    if (dispatch.logStream) dispatch.logStream.write(line + '\n');
    broadcastDispatchLine(dispatch, line);
  });

  proc.on('close', (code) => {
    if (dispatch._timeoutHandle) {
      clearTimeout(dispatch._timeoutHandle);
      dispatch._timeoutHandle = null;
    }
    if (dispatch._warningHandle) {
      clearTimeout(dispatch._warningHandle);
      dispatch._warningHandle = null;
    }
    if (dispatch._mergeHandled) {
      // Agent called POST /complete before exiting — status already set to merge_pending.
      // Do not overwrite status. Just clean up streams and persist.
      dispatch.process = null;
      if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
      if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }
      saveDispatchToDb(dispatch).catch(e => console.error('[dispatch close] saveDispatchToDb (merge_pending):', e.message));
      return;
    }

    // Classify exit type before overwriting status.
    // _killedIntentionally is set by the DELETE endpoint before sending SIGTERM.
    // _timedOut is set by killOnTimeout before sending SIGTERM.
    if (dispatch._killedIntentionally) {
      dispatch.exit_type = 'killed';
    } else if (dispatch._timedOut) {
      dispatch.exit_type = 'timeout';
    } else if (code === 0) {
      dispatch.exit_type = 'graceful';
    } else {
      // Non-zero exit without intentional kill: crash, SIGKILL, OOM, or other ungraceful termination.
      dispatch.exit_type = 'interrupted';
    }
    db.updateDispatchExitType(dispatch.id, dispatch.exit_type).catch(e =>
      console.error('[dispatch close] updateDispatchExitType:', e.message)
    );

    dispatch.status = code === 0 ? 'completed' : 'failed';
    if (code === 0 && dispatch.dispatch_mode === 'auto_implement') {
      dispatch._exitedWithoutSignal = true;
    }
    dispatch.completed_at = new Date().toISOString();
    dispatch.process = null;
    if (dispatch.logStream) { dispatch.logStream.end(); dispatch.logStream = null; }
    if (dispatch._tailInterval) { clearInterval(dispatch._tailInterval); dispatch._tailInterval = null; }

    // Cost anomaly and scope violation detection run after close; both are best-effort.
    (async () => {
      try {
        const { avg_cost, count } = await db.getProjectAvgDispatchCost(dispatch.project_key);
        if (count >= 3 && avg_cost > 0 && dispatch.cost_usd > avg_cost * 2 && dispatch.dispatch_mode !== 'project_refinement') {
          dispatch.session_log = dispatch.session_log || [];
          dispatch.session_log.push({
            trigger: 'cost-anomaly',
            summary: `Cost $${dispatch.cost_usd?.toFixed(4)} is ${(dispatch.cost_usd / avg_cost).toFixed(1)}x the 30-day average ($${avg_cost.toFixed(4)}) for this project`,
            related_items: [dispatch.id],
            detected_at: new Date().toISOString(),
          });
        }
      } catch (err) {
        console.error('[cost-anomaly] detection failed:', err.message);
      }
    })();

    // Scope boundary violation detection: flag dispatches that modified files outside
    // their contract's declared scope_boundary. Best-effort — skipped on any error.
    if (dispatch.worktree_path && dispatch.contract?.scope_boundary) {
      try {
        const sourceBranch = dispatch.source_branch || 'HEAD~1';
        const diffOutput = execFileSync(
          'git', ['diff', '--name-only', sourceBranch],
          { cwd: dispatch.worktree_path, encoding: 'utf8', timeout: 5000 }
        );
        const changedFiles = diffOutput.split('\n').filter(Boolean);
        const boundary = dispatch.contract.scope_boundary.replace(/\/$/, '');
        const violating = changedFiles.filter(f => !f.startsWith(boundary + '/') && f !== boundary);
        if (violating.length > 0) {
          dispatch.session_log = dispatch.session_log || [];
          dispatch.session_log.push({
            trigger: 'scope-violation',
            summary: `${violating.length} file(s) modified outside scope boundary '${boundary}': ${violating.slice(0, 3).join(', ')}${violating.length > 3 ? ` +${violating.length - 3} more` : ''}`,
            related_items: [dispatch.id],
            detected_at: new Date().toISOString(),
          });
        }
      } catch {
        // worktree may be gone or git failed — skip silently
      }
    }

    if (dispatch.dispatch_mode === 'task_creation' && dispatch.status === 'completed') {
      (async () => {
        try {
          const output = (dispatch.output || []).map(line => {
            try { return extractStreamText(JSON.parse(line)) || ''; } catch { return ''; }
          }).join('');
          const match = output.match(/CREATED_WORK_ITEM:\s*(W-\d+)/);
          if (match) {
            const workItemId = match[1];
            await db.linkDispatchToWorkItem(dispatch.id, workItemId);
          } else {
            dispatch.output = [...(dispatch.output || []), JSON.stringify({ type: 'stderr', content: '\n\n[No work item was created. Open the direct form to create manually.]' })];
          }
        } catch (err) {
          console.error('Task creation link failed:', err.message);
        }
      })();
    }

    if (dispatch.dispatch_mode === 'project_refinement' && dispatch.status === 'completed') {
      (async () => {
        try {
          const fullText = (dispatch.output || []).map(line => {
            try { return extractStreamText(JSON.parse(line)) || ''; } catch { return ''; }
          }).join('');

          const match = fullText.match(/# RefinementSummary\s*```json\s*([\s\S]*?)```/);
          if (!match) {
            const errMsg = 'RefinementSummary block not found in output';
            dispatch.completion_summary_error = errMsg;
            await db.updateDispatchMergeResult(dispatch.id, { completion_summary_error: errMsg });
            return;
          }

          let summary;
          try {
            summary = JSON.parse(match[1]);
          } catch (parseErr) {
            const errMsg = `RefinementSummary parse failed: ${parseErr.message}`;
            dispatch.completion_summary_error = errMsg;
            await db.updateDispatchMergeResult(dispatch.id, { completion_summary_error: errMsg });
            return;
          }

          if (dispatch.dry_run) return;

          await applyRefinementSummary(dispatch.id, summary, { db });
        } catch (handlerErr) {
          console.error(`[project_refinement] close handler error for ${dispatch.id}:`, handlerErr);
          const errMsg = 'Unhandled error in refinement close handler';
          dispatch.completion_summary_error = errMsg;
          try {
            await db.updateDispatchMergeResult(dispatch.id, { completion_summary_error: errMsg });
          } catch {}
        }
      })();
    }

    if (dispatch.dispatch_mode === 'refinement' && dispatch.status === 'completed') {
      (async () => {
        try {
          const fullText = (dispatch.output || []).map(line => {
            try { return extractStreamText(JSON.parse(line)) || ''; } catch { return ''; }
          }).join('');
          const match = fullText.match(/# DispatchContract\s*```json\s*([\s\S]*?)```/);
          if (match) {
            const contract = JSON.parse(match[1]);
            const contractBlock = [
              contract.goal ? `**Goal:** ${contract.goal}` : '',
              contract.expected_output ? `**Expected Output:** ${contract.expected_output}` : '',
              contract.constraints?.length ? `**Constraints:**\n${contract.constraints.map(c => `- ${c}`).join('\n')}` : '',
              contract.failure_conditions?.length ? `**Failure Conditions:**\n${contract.failure_conditions.map(c => `- ${c}`).join('\n')}` : '',
            ].filter(Boolean).join('\n\n');

            await db.updateWorkItemRefinement(dispatch.work_item_id, {
              description: contractBlock,
              status: 'planned'
            });
          }
        } catch (err) {
          console.error('Refinement extraction failed:', err.message);
        }
      })();
    }

    if (dispatch.prompt_file) {
      unlinkFile(dispatch.prompt_file).catch(() => {});
      dispatch.prompt_file = null;
    }

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
