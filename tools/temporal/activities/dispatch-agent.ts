import { Context } from '@temporalio/activity';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3777';
const POLL_INTERVAL_MS = 5_000;
// After this many consecutive polls where the dispatch ID is absent from the active list
// (and output lines have been observed), infer the dispatch has completed and was cleaned up.
// Prevents infinite-poll hangs when a dispatch completes and its entry ages out of the list.
// See ADR-002 §Remaining work — the root fix is GET /api/dispatch/:id.
const MAX_CONSECUTIVE_MISSES = 5;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'killed', 'interrupted']);

export interface DashboardDispatchInput {
  workItemId: string;
  projectKey: string;
  permissionMode?: 'plan' | 'acceptEdits';
  additionalInstructions?: string;
}

export interface DashboardDispatchResult {
  dispatchId: string;
  finalStatus: 'completed' | 'failed' | 'killed' | 'interrupted';
  outputLineCount: number;
}

interface HeartbeatDetails {
  dispatchId: string;
  cursor: number;
  phase: string;
}

interface ActiveDispatchSummary {
  id: string;
  work_item_id: string | null;
  status: string;
}

function isTerminalStatus(status: string): status is DashboardDispatchResult['finalStatus'] {
  return TERMINAL_STATUSES.has(status);
}

async function findRunningDispatch(workItemId: string): Promise<string | null> {
  const response = await fetch(`${DASHBOARD_URL}/api/dispatch/active`);
  if (!response.ok) return null;
  const list = (await response.json()) as ActiveDispatchSummary[];
  return list.find(d => d.work_item_id === workItemId && d.status === 'running')?.id ?? null;
}

async function createDispatch(input: DashboardDispatchInput): Promise<string> {
  const response = await fetch(`${DASHBOARD_URL}/api/dispatch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_key: input.projectKey,
      work_item_id: input.workItemId,
      permission_mode: input.permissionMode ?? 'acceptEdits',
      additional_instructions: input.additionalInstructions ?? '',
    }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`POST /api/dispatch failed: ${response.status} — ${body}`);
  }
  const data = (await response.json()) as { id: string };
  return data.id;
}

// Returns the dispatch status, or null if the dispatch is not present in the active list.
async function getDispatchStatusRaw(dispatchId: string): Promise<string | null> {
  const response = await fetch(`${DASHBOARD_URL}/api/dispatch/active`);
  if (!response.ok) return null;
  const list = (await response.json()) as ActiveDispatchSummary[];
  return list.find(d => d.id === dispatchId)?.status ?? null;
}

async function getLogLineCount(dispatchId: string, afterLine: number): Promise<number> {
  const response = await fetch(`${DASHBOARD_URL}/api/dispatch/${dispatchId}/log?after=${afterLine}`);
  if (!response.ok) return 0;
  const text = await response.text();
  return text.trim() ? text.trim().split('\n').length : 0;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Wraps POST /api/dispatch as a heartbeat-equipped Temporal activity.
//
// Idempotency (two layers):
//   1. Heartbeat recovery: on activity retry, reads heartbeatDetails for a stored dispatchId
//      from the previous attempt. Skips creation entirely, resumes polling from the stored cursor.
//   2. Active-list check: if no heartbeat, scans /api/dispatch/active for a running dispatch
//      on the same workItemId before creating a new one.
//
// Liveness: if the dispatch ID disappears from the active list after output has been produced,
// the activity infers completion after MAX_CONSECUTIVE_MISSES polls. This handles the case
// where a completed dispatch is cleaned up before the activity detects terminal status.
// Root fix (pending): add GET /api/dispatch/:id for authoritative single-item lookup.
//
// Timeout relationship: the dashboard's scheduleDispatchTimeout kills the subprocess first.
// The Temporal startToCloseTimeout (4h) intentionally exceeds the dashboard max (150 min).
// The two systems are complementary: dashboard manages subprocess lifetime,
// Temporal manages coordination state.
export async function dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult> {
  const ctx = Context.current();

  // Layer 1: heartbeat recovery — recover dispatchId and cursor from a previous attempt.
  const recovered = ctx.info.heartbeatDetails as HeartbeatDetails | undefined;
  const recoveredDispatchId = recovered?.dispatchId;
  let cursor = recovered?.cursor ?? 0;

  // Layer 2: active-list idempotency — only used if no heartbeat recovery.
  let dispatchId: string;
  if (recoveredDispatchId) {
    dispatchId = recoveredDispatchId;
  } else {
    const existingId = await findRunningDispatch(input.workItemId);
    dispatchId = existingId ?? await createDispatch(input);
  }

  let consecutiveMisses = 0;

  while (true) {
    ctx.heartbeat({ dispatchId, cursor, phase: 'polling' });

    const [status, newLines] = await Promise.all([
      getDispatchStatusRaw(dispatchId),
      getLogLineCount(dispatchId, cursor),
    ]);
    cursor += newLines;

    if (status !== null && isTerminalStatus(status)) {
      return { dispatchId, finalStatus: status, outputLineCount: cursor };
    }

    if (status === null) {
      consecutiveMisses++;
      // If output was produced and the entry has disappeared, the dispatch likely completed.
      if (consecutiveMisses >= MAX_CONSECUTIVE_MISSES && cursor > 0) {
        return { dispatchId, finalStatus: 'completed', outputLineCount: cursor };
      }
    } else {
      consecutiveMisses = 0;
    }

    await delay(POLL_INTERVAL_MS);
  }
}
