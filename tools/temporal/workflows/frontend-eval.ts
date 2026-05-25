// Child workflow stub for future isolated frontend domain EXECUTION tasks.
//
// Activity vs Child Workflow decision rule:
//   analysis (read, assess, classify, plan) → activity calling Claude API directly
//   execution (edit files, run tests, apply changes) → child workflow calling dispatchAgentActivity
//
// The current MVP uses analyzeFrontendImpact activity for frontend analysis.
// This child workflow is scaffolded for future use when frontend changes need
// a full Claude Code session (edit components, run tests, apply design system changes).
import { proxyActivities } from '@temporalio/workflow';
import type { DashboardDispatchInput, DashboardDispatchResult } from '../activities/dispatch-agent';

export interface FrontendEvalInput {
  requirement: string;
  projectKey: string;
  workItemId: string;
  additionalInstructions?: string;
}

export interface FrontendEvalResult {
  status: 'completed' | 'failed';
  dispatchId: string;
  outputLineCount: number;
}

const { dashboardDispatch } = proxyActivities<{
  dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult>;
}>({
  startToCloseTimeout: '4h',
  heartbeatTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});

// Dispatches a full Claude Code session for frontend domain execution work.
//
// NAMESPACE WARNING: this workflow and its activities must only be started from within
// the 'architect' namespace on task queue 'user-session'. Activity proxy resolution
// inherits the calling workflow's namespace and task queue — calling this as a child
// workflow from sdlcPipeline (namespace: default, queue: sdlc-pipeline) would cause
// the dashboardDispatch activity to wait on the wrong task queue and time out silently.
// Call via: workflow.startChildWorkflow(frontendEvalWorkflow, input, { taskQueue: 'user-session' }).
export async function frontendEvalWorkflow(input: FrontendEvalInput): Promise<FrontendEvalResult> {
  const result = await dashboardDispatch({
    workItemId: input.workItemId,
    projectKey: input.projectKey,
    permissionMode: 'acceptEdits',
    additionalInstructions: `Frontend domain execution: ${input.requirement}${
      input.additionalInstructions ? `\n${input.additionalInstructions}` : ''
    }`,
  });
  return {
    status: result.finalStatus === 'completed' ? 'completed' : 'failed',
    dispatchId: result.dispatchId,
    outputLineCount: result.outputLineCount,
  };
}
