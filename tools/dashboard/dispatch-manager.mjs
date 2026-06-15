import { readFileSync, existsSync, createWriteStream, appendFileSync } from 'node:fs';
import { unlink as unlinkFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { dispatches, terminals, cliSessions, saveDispatchToDb, saveTerminalToDb, saveCliSessionToDb, archiveSession } from './state.mjs';
import { applyRefinementSummary } from './lib/refine-apply.mjs';
import { validateOrgName } from './lib/portfolio-validation.mjs';
import { isPidAlive, tmuxSessionExists, captureTmuxScrollback, cleanTmuxCapture, termEventLogPath, sleep } from './utils.mjs';
import { CLAUDE_BIN, ROOT, PORTFOLIO, WORK, LOGS_DIR, TMUX_AVAILABLE, TIMEOUT_WARNING_RATIO, IDLE_THRESHOLD_MS, MAX_AUTO_EXTENDS, EXTEND_DURATION_MS, INPUT_NEEDED_SOURCE, DISPATCH_TIMEOUT_MS } from './constants.mjs';
import { loadResumeContext, buildResumePrompt, buildExecutePhaseSection, selectAgentsForDispatch } from './prompt-builder.mjs';
import * as db from './db.mjs';
import { EventStream } from './event-stream.mjs';
import { getAdapter } from './adapters/index.mjs';
import { buildPermissionArgs } from './permission-args.mjs';
import { createResumeDispatch } from './utils/dispatch-factory.mjs';
import { validateModel } from './utils.mjs';
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
      // Chain-aware restore: a plan_execute phase-1 whose log ended in a clean result event
      // completed before the process died — land it at the durable execute_pending checkpoint,
      // never silent 'interrupted'. Autostart fires only from the live in-process close handler.
      if (dispatch.chain_mode === 'plan_execute' && dispatch.chain_phase === 'plan' && logEndedCleanly(dispatch.output)) {
        dispatch.status = 'execute_pending';
      } else {
        dispatch.status = 'interrupted';
      }
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
    if (d.status === 'execute_starting') {
      // Transient: a /execute call flipped phase-1 out of execute_pending but the server
      // restarted before phase 2 was confirmed spawned. Roll back to the durable
      // execute_pending checkpoint so the user can retry the approve-&-execute action.
      const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
      let output = [];
      try { output = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()); } catch {}
      d.status = 'execute_pending';
      await db.updateDispatchStatus(d.id, 'execute_pending', d.completed_at || now);
      dispatches.set(d.id, {
        ...d, output, lastLines: [], wsClients: new Set(), process: null,
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
        // PID dead. Load log content first so chain-aware recovery can inspect it.
        const logPath = join(LOGS_DIR, `${d.id}.jsonl`);
        let output = [];
        try { output = readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim()); } catch {}

        // Chain-aware restore: a plan_execute phase-1 that finished cleanly before the process
        // died lands at the durable execute_pending checkpoint, never silent 'interrupted'.
        // Autostart never fires here — it is gated to the live in-process close handler.
        if (d.chain_mode === 'plan_execute' && d.chain_phase === 'plan' && logEndedCleanly(output)) {
          d.status = 'execute_pending';
          d.completed_at = now;
          await db.updateDispatchStatus(d.id, 'execute_pending', now);
        } else {
          interruptedDispatches++;
          d.status = 'interrupted';
          d.completed_at = now;
          await db.updateDispatchStatus(d.id, 'interrupted', now);
          await archiveSession(d, 'dispatch').catch(e => console.error('[restore] archiveSession dispatch:', e.message));
        }
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
            // Re-attach only: do NOT carry _pendingPrompt or call startInjection.
            // The original delivery already ran (its prompt_injection_status is in
            // the event log); a re-attached, already-running session must never be
            // re-delivered.
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

// Detect whether a plan-phase agent actually produced a plan, by scanning its JSONL output
// for an ExitPlanMode tool-use event. Refuses to auto-execute an empty plan.
export function hasPlanMarker(output) {
  for (const line of output || []) {
    let evt;
    try { evt = JSON.parse(line); } catch { continue; }
    if (evt.type === 'content_block_start' && evt.content_block?.type === 'tool_use'
        && evt.content_block?.name === 'ExitPlanMode') return true;
    if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_use' && block.name === 'ExitPlanMode') return true;
      }
    }
  }
  return false;
}

// Whether a dispatch's JSONL output ends in a clean `result` event — i.e. the claude process
// finished its turn rather than being cut off. Used by restart-survival to distinguish a
// completed plan phase from an interrupted one.
export function logEndedCleanly(output) {
  for (let i = (output?.length ?? 0) - 1; i >= 0; i--) {
    let evt;
    try { evt = JSON.parse(output[i]); } catch { continue; }
    if (evt.type === 'result') return true;
    // Only the trailing event matters; a non-result trailing event means it was cut off.
    return false;
  }
  return false;
}

// Whether a contract scope_boundary names a real sub-scope worth enforcing at the file level.
// A boundary of '.', './', '' or unset means "whole worktree" — no sub-scope to enforce, so the
// file-level scope-violation check is skipped (worktree isolation remains the hard guardrail).
// `git diff --name-only` emits paths without a './' prefix, so a '.' boundary would otherwise
// flag every changed file as out-of-scope.
export function isEnforceableScopeBoundary(scopeBoundary) {
  if (!scopeBoundary) return false;
  const normalized = String(scopeBoundary).trim().replace(/\/$/, '');
  return normalized !== '' && normalized !== '.';
}

// Decide the fate of a completed phase-1 plan dispatch: spawn phase 2 (autostart) or hold at
// execute_pending (gated / missing guard). Loud-fail to 'failed' on missing session or revocation.
export async function handlePlanPhaseComplete(dispatch) {
  const hasSession = !!dispatch.claude_session_id;
  const revoked = !!dispatch.revoked_at;
  const hasScopeBoundary = !!dispatch.contract?.scope_boundary;

  if (!hasSession || revoked) {
    dispatch.status = 'failed';
    const reason = !hasSession ? 'missing claude_session_id' : 'session revoked';
    console.error(`[plan-execute] ${dispatch.id} cannot proceed to execute — ${reason}; marking failed.`);
    await saveDispatchToDb(dispatch);
    return;
  }

  if (dispatch.chain_autostart === true && hasScopeBoundary) {
    await startExecutePhase(dispatch);
    return;
  }

  // Gated, or autostart requested without a scope_boundary — hold at the durable checkpoint.
  dispatch.status = 'execute_pending';
  await saveDispatchToDb(dispatch);
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

    // User initiated a graceful interrupt (POST /interrupt sent SIGINT).
    // Classify exit_type explicitly for observability. Fall through to normal DB write path.
    if (dispatch._gracefulInterrupt) {
      dispatch.exit_type = 'interrupted';
      if (dispatch._interruptTimers) {
        dispatch._interruptTimers.forEach(clearTimeout);
        dispatch._interruptTimers = null;
      }
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

    // User-initiated interrupt: set status 'interrupted' so the session appears in the
    // recovery surface and is restartable. Kill intent overrides (status = 'killed' below).
    if (dispatch._gracefulInterrupt && !dispatch._killedIntentionally) {
      dispatch.status = 'interrupted';
    } else {
      dispatch.status = code === 0 ? 'completed' : 'failed';
    }
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
    // A root boundary ('.', './', '') means "whole worktree, no sub-scope enforcement" —
    // git-worktree isolation is the hard guardrail there, so skip the file-level check.
    if (dispatch.worktree_path && isEnforceableScopeBoundary(dispatch.contract?.scope_boundary)) {
      (async () => {
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
            dispatch.scope_violation = true;
            dispatch.session_log = dispatch.session_log || [];
            dispatch.session_log.push({
              trigger: 'scope-violation',
              summary: `${violating.length} file(s) modified outside scope boundary '${boundary}': ${violating.slice(0, 3).join(', ')}${violating.length > 3 ? ` +${violating.length - 3} more` : ''}`,
              related_items: [dispatch.id],
              detected_at: new Date().toISOString(),
            });
            await db.setScopeViolation(dispatch.id, true);
          }
        } catch (err) {
          if (existsSync(dispatch.worktree_path)) {
            console.warn(`[scope-check] git diff failed for dispatch ${dispatch.id}: ${err.message}`);
          }
        }
      })();
    }

    if (dispatch.dispatch_mode === 'task_creation' && dispatch.status === 'completed') {
      (async () => {
        try {
          const output = (dispatch.output || []).map(line => {
            try { return extractStreamText(JSON.parse(line)) || ''; } catch { return ''; }
          }).join('');
          const match = output.match(/CREATED_WORK_ITEM:\s*([A-Za-z]+-\d+)/);
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

    // --- plan_execute chain transition (phase 1 → phase 2) ---
    // Gate on completed (not raw code===0) so kill/interrupt/timeout/merge paths are excluded.
    if (dispatch.status === 'completed'
        && dispatch.chain_mode === 'plan_execute'
        && dispatch.chain_phase === 'plan'
        && hasPlanMarker(dispatch.output)) {
      (async () => {
        try {
          await handlePlanPhaseComplete(dispatch);
        } catch (e) {
          console.error(`[plan-execute] phase transition failed for ${dispatch.id}:`, e.message);
        }
      })();
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
    await depsDb.query(
      'UPDATE dispatches SET merged_at = NOW(), merge_target = $2 WHERE id = $1',
      [dispatch.id, dispatch.source_branch]
    );
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

/**
 * Gracefully interrupt a running dispatch: SIGINT → SIGTERM(10s) → SIGKILL(15s).
 * Returns { claude_session_id } for the route to echo back.
 * Throws { status, code, error } on failure for the route to return as an error response.
 */
export function interruptDispatch(id, inMemoryDispatches) {
  const dispatch = inMemoryDispatches.get(id);
  if (!dispatch) throw { status: 404, code: 'not_found', error: 'dispatch not found' };
  if (dispatch.status !== 'running') throw { status: 400, code: 'not_running', error: 'dispatch is not running' };
  if (dispatch._gracefulInterrupt) throw { status: 409, code: 'interrupt_in_progress', error: 'session is already being interrupted' };

  dispatch._gracefulInterrupt = true;

  const proc = dispatch.process;
  const pid = dispatch.pid;

  if (!proc && (!pid || !isPidAlive(pid))) {
    dispatch._gracefulInterrupt = false;
    return { claude_session_id: dispatch.claude_session_id };
  }

  try {
    if (proc) {
      proc.kill('SIGINT');
    } else {
      process.kill(pid, 'SIGINT');
    }
  } catch (e) {
    if (e.code === 'ESRCH') {
      console.warn('[interrupt] SIGINT ESRCH: dispatch', id, 'pid', pid, 'already gone');
      dispatch._gracefulInterrupt = false;
      return { claude_session_id: dispatch.claude_session_id };
    }
    throw e;
  }

  const sigterm = setTimeout(() => {
    try { proc ? proc.kill('SIGTERM') : process.kill(pid, 'SIGTERM'); } catch {}
  }, 10000);
  const sigkill = setTimeout(() => {
    try { proc ? proc.kill('SIGKILL') : process.kill(pid, 'SIGKILL'); } catch {}
  }, 15000);

  if (proc) {
    proc.on('close', () => {
      clearTimeout(sigterm);
      clearTimeout(sigkill);
    });
  }

  dispatch._interruptTimers = [sigterm, sigkill];
  return { claude_session_id: dispatch.claude_session_id };
}

const RESTARTABLE_STATUSES = new Set(['interrupted', 'suspended', 'failed']);

/**
 * Restart a finished dispatch by re-spawning with --resume SESSION_ID from the same cwd.
 * Atomically revokes the original before spawning to prevent concurrent double-restart.
 * Returns the new dispatch object.
 * Throws { status, code, error } on failure.
 */
export async function restartDispatch(id, opts, inMemoryDispatches, dbModule) {
  const original = inMemoryDispatches.get(id) || await dbModule.getDispatchById(id);
  if (!original) throw { status: 404, code: 'not_found', error: 'dispatch not found' };

  if (!RESTARTABLE_STATUSES.has(original.status)) {
    throw { status: 400, code: 'not_restartable', error: 'session is not restartable' };
  }
  if (!original.claude_session_id) {
    throw { status: 400, code: 'no_session_id', error: 'no session ID available for restart' };
  }
  if (original.revoked_at) {
    throw { status: 409, code: 'session_revoked', error: 'session is revoked' };
  }

  const { worktree_path, project_path } = original;
  let effectiveCwd;
  if (worktree_path) {
    if (!existsSync(worktree_path)) {
      throw { status: 400, code: 'worktree_missing', error: 'worktree was removed — re-dispatch to create a new one' };
    }
    effectiveCwd = worktree_path;
  } else {
    effectiveCwd = project_path;
  }

  const revoked = await dbModule.revokeDispatch(original.id);
  if (!revoked) {
    throw { status: 409, code: 'session_revoked', error: 'session was concurrently restarted or revoked' };
  }
  if (inMemoryDispatches.has(original.id)) {
    inMemoryDispatches.get(original.id).revoked_at = new Date().toISOString();
  }

  const newId = `D-${Date.now()}`;
  const { work_item_id, epic_id, project_key, title, permission_mode, skip_permissions, worktree_branch, source_branch, contract, dispatch_mode } = original;

  const resolvedPermMode = permission_mode || 'acceptEdits';
  const resolvedSkipPerms = skip_permissions === true || skip_permissions === 'true';

  const dispatch = {
    id: newId,
    work_item_id: work_item_id || null,
    epic_id: epic_id || null,
    project_key: project_key || '',
    project_path: project_path || '',
    title: title || '',
    permission_mode: resolvedPermMode,
    skip_permissions: resolvedSkipPerms,
    dispatch_mode: dispatch_mode || 'standard',
    contract: contract || null,
    worktree_path: worktree_path || null,
    worktree_branch: worktree_branch || null,
    source_branch: source_branch || null,
    claude_session_id: original.claude_session_id,
    previous_dispatch_id: original.id,
    status: 'running',
    agent_phase: 'generating',
    agent_phase_history: [],
    output: [],
    lastLines: [],
    wsClients: new Set(),
    started_at: new Date().toISOString(),
    completed_at: null,
    _autoExtended: false,
  };

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', 'sonnet',
    '--resume', original.claude_session_id,
    ...buildPermissionArgs({ permissionMode: resolvedPermMode, skipPermissions: resolvedSkipPerms }),
  ];
  args.push('--add-dir', ROOT);

  const { workItem, portfolio } = await loadResumeContext({ work_item_id, project_key });
  const agentDefs = await selectAgentsForDispatch({ workItem, portfolio });
  if (agentDefs.length) args.push('--agents', JSON.stringify(agentDefs));

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd: effectiveCwd,
      env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    console.error('[restart] spawn failed after revoke:', e.message, 'original id was', original.id);
    throw { status: 500, code: 'spawn_failed', error: 'Spawn failed — original session is revoked. Re-dispatch to recover.' };
  }

  dispatch.process = proc;
  dispatch.pid = proc.pid;
  const logPath = join(LOGS_DIR, `${newId}.jsonl`);
  dispatch.logPath = logPath;
  dispatch.logStream = createWriteStream(logPath, { flags: 'a' });
  wireDispatchHandlers(dispatch, proc);

  const tier = work_item_id ? 'medium' : 'small';
  scheduleDispatchTimeout(dispatch, DISPATCH_TIMEOUT_MS[tier] ?? DISPATCH_TIMEOUT_MS.medium, saveDispatchToDb);

  if (opts?.additional_instructions) {
    const prompt = buildResumePrompt({ workItem, contract: null, additionalInstructions: opts.additional_instructions });
    proc.stdin.write(prompt + '\n');
  }
  proc.stdin.end();

  inMemoryDispatches.set(newId, dispatch);
  try {
    await saveDispatchToDb(dispatch);
  } catch (dbErr) {
    console.warn('[dispatch-restart] DB persist failed — session active in-memory only, will not survive restart:', dbErr.message);
  }
  return dispatch;
}

/**
 * Spawn phase 2 of a plan_execute chain: resume the phase-1 plan session with acceptEdits +
 * --dangerously-skip-permissions in the same isolated worktree, and instruct the agent to
 * implement its already-approved plan. Creates a NEW dispatch record linked to the phase-1
 * record via chain_parent_id. Mirrors the resume pattern.
 *
 * The caller MUST have already verified: phase-1 status completed, chain_phase==='plan',
 * claude_session_id present, revoked_at unset, scope_boundary contract present.
 *
 * @param {Object} planDispatch — the phase-1 (plan) dispatch record
 * @returns {Promise<Object>} the new phase-2 dispatch record
 */
export async function startExecutePhase(planDispatch) {
  const effectiveCwd = planDispatch.worktree_path && existsSync(planDispatch.worktree_path)
    ? planDispatch.worktree_path
    : planDispatch.project_path;

  const id = `D-${Date.now()}`;
  // Phase 2 inherits the phase-1 model. validateModel is idempotent — a persisted resolved id
  // passes through, a short alias resolves, and an unset model falls back to sonnet.
  const inheritedModel = validateModel(planDispatch.model);
  const dispatch = createResumeDispatch({
    id,
    projectKey: planDispatch.project_key,
    projectPath: planDispatch.project_path,
    workItemId: planDispatch.work_item_id || null,
    epicId: planDispatch.epic_id || null,
    title: planDispatch.title || '',
    model: inheritedModel,
    permissionMode: 'acceptEdits',
    skipPermissions: true,
    claudeSessionId: planDispatch.claude_session_id,
    contract: planDispatch.contract || null,
    worktreePath: planDispatch.worktree_path || null,
    worktreeBranch: planDispatch.worktree_branch || null,
    sourceBranch: planDispatch.source_branch || null,
    chainMode: 'plan_execute',
    chainPhase: 'execute',
    chainAutostart: planDispatch.chain_autostart ?? null,
    chainParentId: planDispatch.id,
  });

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--model', inheritedModel,
    '--resume', planDispatch.claude_session_id,
    ...buildPermissionArgs({ permissionMode: 'acceptEdits', skipPermissions: true }),
  ];
  args.push('--add-dir', ROOT);

  const { workItem, portfolio } = await loadResumeContext({
    work_item_id: planDispatch.work_item_id,
    project_key: planDispatch.project_key,
  });
  const agentDefs = await selectAgentsForDispatch({ workItem, portfolio });
  if (agentDefs.length) args.push('--agents', JSON.stringify(agentDefs));

  let proc;
  try {
    proc = spawn(CLAUDE_BIN, args, {
      cwd: effectiveCwd,
      env: { ...process.env, ARCHITECT_ROOT: ROOT, ARCHITECT_PORTFOLIO_DIR: PORTFOLIO },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (e) {
    throw new Error(`Failed to spawn execute phase: ${e.message}`);
  }

  dispatch.process = proc;
  dispatch.pid = proc.pid;
  const logPath = join(LOGS_DIR, `${id}.jsonl`);
  dispatch.logPath = logPath;
  dispatch.logStream = createWriteStream(logPath, { flags: 'a' });

  // Synthetic phase-transition marker for observability — records the plan→execute handoff
  // in the new dispatch's log before the resumed process writes anything.
  const markerLine = JSON.stringify({
    type: 'phase_transition',
    chain_mode: 'plan_execute',
    from_phase: 'plan',
    to_phase: 'execute',
    chain_parent_id: planDispatch.id,
    at: new Date().toISOString(),
  });
  dispatch.output.push(markerLine);
  dispatch.logStream.write(markerLine + '\n');

  wireDispatchHandlers(dispatch, proc);

  const tier = planDispatch.work_item_id ? 'medium' : 'small';
  scheduleDispatchTimeout(dispatch, DISPATCH_TIMEOUT_MS[tier] ?? DISPATCH_TIMEOUT_MS.medium, saveDispatchToDb);

  const prompt = buildExecutePhaseSection();
  proc.stdin.write(prompt + '\n');
  proc.stdin.end();

  dispatches.set(id, dispatch);
  try {
    await saveDispatchToDb(dispatch);
  } catch (dbErr) {
    console.warn('[plan-execute] phase-2 DB persist failed — active in-memory only:', dbErr.message);
  }
  return dispatch;
}
