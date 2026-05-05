import * as db from './db.mjs';

// --- Session registries (ES module singletons — shared across all importers) ---
export const dispatches = new Map();
export const terminals = new Map();
export const cliSessions = new Map();

// --- Session persistence helpers — write to PostgreSQL per mutation ---

export async function saveDispatchToDb(d) {
  await db.saveDispatch({
    id: d.id, work_item_id: d.work_item_id, epic_id: d.epic_id,
    project_key: d.project_key, project_path: d.project_path,
    title: d.title || d.work_item_id, permission_mode: d.permission_mode || 'acceptEdits',
    skip_permissions: d.skip_permissions || false,
    status: d.status, started_at: d.started_at, completed_at: d.completed_at,
    cost_usd: d.cost_usd || null,
    pid: d.pid || null,
    claude_session_id: d.claude_session_id || null,
    worktree_path: d.worktree_path || null,
    worktree_branch: d.worktree_branch || null,
    source_branch: d.source_branch || null,
    dispatch_mode: d.dispatch_mode || 'standard',
    agent_phase: d.agent_phase ?? null,
    agent_phase_history: d.agent_phase_history || [],
    timeout_at: d.timeout_at || null,
  });
}

export async function saveTerminalToDb(t) {
  await db.saveTerminal({
    id: t.id, type: t.type || 'claude', work_item_id: t.work_item_id, epic_id: t.epic_id,
    project_key: t.project_key, project_path: t.project_path, org_key: t.org_key || null,
    title: t.title, permission_mode: t.permission_mode || 'acceptEdits',
    skip_permissions: t.skip_permissions || false,
    status: t.status, started_at: t.started_at, exited_at: t.exited_at,
    pid: t.pid || null, tmux_session: t.tmux_session || null,
    claude_session_id: t.claude_session_id || null,
    agent_type: t.agent_type || t.type || 'claude',
    head_seq: t.eventStream ? t.eventStream.headSeq : 0,
  });
}

export async function saveCliSessionToDb(c) {
  await db.saveCliSession({
    id: c.id, project_key: c.project_key, work_item_id: c.work_item_id,
    epic_id: c.epic_id, title: c.title, pid: c.pid,
    status: c.status, registered_at: c.registered_at, exited_at: c.exited_at,
  });
}

// --- Archive session to permanent history ---
export async function archiveSession(session, type) {
  const endedAt = type === 'cli' ? session.exited_at : (type === 'dispatch' ? session.completed_at : session.exited_at);
  const startedAt = type === 'cli' ? session.registered_at : session.started_at;
  if (!endedAt || !startedAt || !session.project_key) {
    const missing = [!startedAt && 'startedAt', !endedAt && 'endedAt', !session.project_key && 'project_key'].filter(Boolean).join(', ');
    console.warn(`archiveSession(${type} ${session.id}): skipped — missing ${missing}`);
    return;
  }
  try {
    await db.recordSessionHistory({
      id: session.id, type, project_key: session.project_key,
      work_item_id: session.work_item_id, epic_id: session.epic_id,
      title: session.title || '', status: session.status,
      permission_mode: session.permission_mode,
      started_at: startedAt, ended_at: endedAt, cost_usd: session.cost_usd || null,
    });
  } catch (e) {
    console.error(`Failed to archive ${type} ${session.id}:`, e.message);
  }
}

// --- Centralized session finalization: set terminal timestamp + archive ---
export async function finalizeSession(session, type) {
  const now = new Date().toISOString();
  if (type === 'dispatch') {
    if (!session.completed_at) session.completed_at = now;
  } else {
    if (!session.exited_at) session.exited_at = now;
  }
  await archiveSession(session, type);
}
