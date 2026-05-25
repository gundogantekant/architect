import { Context } from '@temporalio/activity';

const DASHBOARD_URL = process.env.DASHBOARD_URL ?? 'http://127.0.0.1:3777';
const POLL_INTERVAL_MS = 5_000;
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

async function getDispatchStatus(dispatchId: string): Promise<string> {
  const response = await fetch(`${DASHBOARD_URL}/api/dispatch/active`);
  if (!response.ok) return 'running';
  const list = (await response.json()) as ActiveDispatchSummary[];
  // GET /api/dispatch/active includes completed dispatches. If the ID is absent,
  // the dispatch was deleted externally while this activity polled. The fallback
  // 'running' causes polling to continue until startToCloseTimeout (4h).
  // Production fix: add GET /api/dispatch/:id for authoritative single-item lookup.
  // See ADR-002 §Remaining work.
  return list.find(d => d.id === dispatchId)?.status ?? 'running';
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
// Idempotency: on activity retry (e.g. after worker restart), checks for an
// existing running dispatch for the same work item before creating a new one.
// This prevents duplicate dispatches when Temporal retries a lost activity.
//
// Timeout relationship: the dashboard's scheduleDispatchTimeout (80%/100% of the
// per-complexity window) kills the subprocess first. The Temporal startToCloseTimeout
// (4h) is intentionally set above the dashboard max (large: 150 min with auto-extend).
// The two systems are complementary: dashboard manages subprocess lifetime,
// Temporal manages coordination state.
export async function dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult> {
  const ctx = Context.current();

  const existingId = await findRunningDispatch(input.workItemId);
  const dispatchId = existingId ?? await createDispatch(input);

  let cursor = 0;

  while (true) {
    ctx.heartbeat({ dispatchId, cursor, phase: 'polling' });

    const [status, newLines] = await Promise.all([
      getDispatchStatus(dispatchId),
      getLogLineCount(dispatchId, cursor),
    ]);
    cursor += newLines;

    if (isTerminalStatus(status)) {
      return { dispatchId, finalStatus: status, outputLineCount: cursor };
    }

    await delay(POLL_INTERVAL_MS);
  }
}
