import {
  proxyActivities,
  defineSignal,
  defineQuery,
  setHandler,
  condition,
} from '@temporalio/workflow';
import type { DashboardDispatchInput, DashboardDispatchResult } from '../activities/dispatch-agent';

// Work item state machine: open → ready → in-progress → in-review → done
// Transitions are driven by Temporal signals (human gates) and activity results.
export type WorkItemState = 'open' | 'ready' | 'in-progress' | 'in-review' | 'done';

export interface SdlcPipelineInput {
  workItemId: string;
  projectKey: string;
  additionalInstructions?: string;
  // When true, dispatch completes without waiting for a review-approved signal.
  // Intended for automated tests and the demo script.
  skipReviewGate?: boolean;
}

export interface SdlcPipelineResult {
  finalState: WorkItemState;
  dispatchId: string;
  finalStatus: DashboardDispatchResult['finalStatus'];
  outputLineCount: number;
}

// Human-gate signals — sent from external tooling (dashboard, CLI, demo script).
export const approveWorkItemSignal = defineSignal<[{ approver: string }]>('approve-work-item');
export const approveReviewSignal = defineSignal<[{ reviewer: string }]>('approve-review');

// Query: allows external callers to read current workflow state without blocking.
export const workItemStateQuery = defineQuery<WorkItemState>('work-item-state');

// Activity proxy — all timeout/retry policy in one place.
// startToCloseTimeout is set above the dashboard's maximum dispatch window
// (large complexity: 120 min + 30 min auto-extend = 150 min) so the dashboard
// always kills the subprocess first. Temporal sees the terminal status and the
// activity returns cleanly. There is no timeout conflict — the two systems are
// layered, not competing.
const { dashboardDispatch } = proxyActivities<{
  dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult>;
}>({
  startToCloseTimeout: '4h',
  heartbeatTimeout: '5m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '10s',
    backoffCoefficient: 2.0,
    maximumInterval: '2m',
  },
});

export async function sdlcPipeline(input: SdlcPipelineInput): Promise<SdlcPipelineResult> {
  let state: WorkItemState = 'open';
  let approvalReceived = false;
  let reviewApproved = false;

  setHandler(approveWorkItemSignal, () => {
    approvalReceived = true;
  });

  setHandler(approveReviewSignal, () => {
    reviewApproved = true;
  });

  setHandler(workItemStateQuery, () => state);

  // Gate 1: wait for human approval before dispatching (open → ready)
  await condition(() => approvalReceived);
  state = 'ready';

  // Dispatch (ready → in-progress)
  state = 'in-progress';
  const result = await dashboardDispatch({
    workItemId: input.workItemId,
    projectKey: input.projectKey,
    additionalInstructions: input.additionalInstructions,
    permissionMode: 'acceptEdits',
  });

  // Dispatch completed — move to in-review
  state = 'in-review';

  // Gate 2: wait for review approval (in-review → done)
  // Skipped when skipReviewGate is true (for demo/test runs).
  if (!input.skipReviewGate) {
    await condition(() => reviewApproved);
  }

  state = 'done';

  return {
    finalState: state,
    dispatchId: result.dispatchId,
    finalStatus: result.finalStatus,
    outputLineCount: result.outputLineCount,
  };
}
