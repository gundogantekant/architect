// Workflow code must be deterministic — no I/O, no Date.now(), no Math.random(), no Node built-ins.
// All I/O lives in activity files. This file is bundled into a V8 isolate by the Temporal worker.
import {
  proxyActivities,
  setHandler,
  condition,
  continueAsNew,
  workflowInfo,
} from '@temporalio/workflow';

// Import types only — value imports would pull activity I/O code into the workflow bundle.
import type { ClassifyIntentInput, SdlcIntent } from '../activities/classify-intent';
import type { RagRetrievalInput, RagContext } from '../activities/rag-retrieval';
import type { AnalyzeCloudInput, CloudAnalysis } from '../activities/analyze-cloud';
import type { AnalyzeFrontendInput, FrontendAnalysis } from '../activities/analyze-frontend';
import type { DashboardDispatchInput, DashboardDispatchResult } from '../activities/dispatch-agent';
import { userMessageSignal, approvalSignal } from '../signals';
import type { UserMessagePayload } from '../signals';
import { sessionStateQuery } from '../queries';
import type { SessionState } from '../queries';

// Maximum messages retained in state passed to continueAsNew.
// Chosen to stay well under Temporal's ~2 MB input payload limit (each message ~2 KB avg).
const MAX_RETAINED_MESSAGES = 100;

export interface ProcessedMessage {
  messageId: string;
  userMessage: string;
  intentType: string;
  synthesis: string;
}

export interface ContinuationState {
  lastMessageId: string;
  recentMessages: ProcessedMessage[];
  totalMessageCount: number;
}

export interface UserSessionInput {
  sessionId: string;
  userId: string;
  projectKey: string;
  // Override the continueAsNew threshold — default 1000; set low (e.g. 3) in tests.
  eventCountThreshold?: number;
  // When true, all messages trigger an approval gate regardless of intent type.
  alwaysRequireApproval?: boolean;
  // When true, the post-approval dashboardDispatch activity is skipped. Use in tests.
  skipDispatch?: boolean;
  // Carried forward by continueAsNew — contains accumulated conversation state.
  continuation?: ContinuationState;
}

export interface UserSessionResult {
  sessionId: string;
  totalMessagesProcessed: number;
}

// Activity proxies — all I/O configuration in one place.
// Activities run in the session-worker on task queue 'user-session', namespace 'architect'.
const { classifyIntent } = proxyActivities<{
  classifyIntent(input: ClassifyIntentInput): Promise<SdlcIntent>;
}>({
  startToCloseTimeout: '2m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2, maximumInterval: '30s' },
});

const { ragRetrieval } = proxyActivities<{
  ragRetrieval(input: RagRetrievalInput): Promise<RagContext>;
}>({
  startToCloseTimeout: '2m',
  retry: { maximumAttempts: 3, initialInterval: '5s', backoffCoefficient: 2, maximumInterval: '30s' },
});

const { analyzeCloudImpact, analyzeFrontendImpact } = proxyActivities<{
  analyzeCloudImpact(input: AnalyzeCloudInput): Promise<CloudAnalysis>;
  analyzeFrontendImpact(input: AnalyzeFrontendInput): Promise<FrontendAnalysis>;
}>({
  startToCloseTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});

const { dashboardDispatch } = proxyActivities<{
  dashboardDispatch(input: DashboardDispatchInput): Promise<DashboardDispatchResult>;
}>({
  startToCloseTimeout: '4h',
  heartbeatTimeout: '5m',
  retry: { maximumAttempts: 3, initialInterval: '10s', backoffCoefficient: 2 },
});

// One UserSessionWorkflow per active user session (keyed by sessionId as workflowId).
// Receives user messages via signal, runs classify → RAG (sequential) then
// cloud + frontend analysis (parallel), optionally gates on human approval,
// and calls continueAsNew near the history limit to survive long conversations.
export async function userSessionWorkflow(input: UserSessionInput): Promise<UserSessionResult> {
  const threshold = input.eventCountThreshold ?? 1000;

  // Restore state from a previous run if this is a continueAsNew continuation.
  let messages: ProcessedMessage[] = input.continuation?.recentMessages ?? [];
  let totalMessageCount = input.continuation?.totalMessageCount ?? 0;
  const processedIds = new Set<string>(messages.map(m => m.messageId));

  // Incoming signal queue — populated by the userMessageSignal handler.
  const messageQueue: UserMessagePayload[] = [];
  let approvalCount = 0;
  let sessionState: SessionState = 'idle';

  // Signal and query handlers must be registered before any await to avoid signal loss.
  setHandler(userMessageSignal, (payload) => {
    // Deduplication: skip messages already processed before a continueAsNew boundary.
    if (!processedIds.has(payload.messageId)) {
      messageQueue.push(payload);
    }
  });

  // Only count explicit approvals (approved: true). A rejection signal does not release the gate.
  setHandler(approvalSignal, (payload) => {
    if (payload.approved) approvalCount++;
  });

  setHandler(sessionStateQuery, () => ({
    sessionId: input.sessionId,
    sessionState,
    messageCount: totalMessageCount,
    historyLength: workflowInfo().historyLength,
  }));

  // Main processing loop — runs until execution timeout (2h, set at workflow.start call-site).
  while (true) {
    // Suspend until a message arrives.
    await condition(() => messageQueue.length > 0);

    const payload = messageQueue.shift()!;
    processedIds.add(payload.messageId);
    sessionState = 'processing';
    totalMessageCount++;

    // Step 1: classify intent (sequential).
    const intent = await classifyIntent({
      userMessage: payload.content,
      projectKey: input.projectKey,
    });

    // Step 2: RAG retrieval (sequential, uses last 10 synthesis strings as history).
    const ragContext = await ragRetrieval({
      projectKey: input.projectKey,
      sessionHistory: messages.slice(-10).map(m => m.synthesis),
    });

    // Step 3: parallel multi-domain analysis — both activities start simultaneously.
    const [cloudAnalysis, frontendAnalysis] = await Promise.all([
      analyzeCloudImpact({
        requirement: payload.content,
        projectKey: input.projectKey,
        ragContext,
      }),
      analyzeFrontendImpact({
        requirement: payload.content,
        projectKey: input.projectKey,
        ragContext,
      }),
    ]);

    // Step 4: inline synthesis (deterministic — no Claude API call in workflow code).
    const synthesis =
      `Intent: ${intent.intentType} (${Math.round(intent.confidence * 100)}% confidence). ` +
      `Cloud [${cloudAnalysis.riskLevel}]: ${cloudAnalysis.summary} ` +
      `Frontend [${frontendAnalysis.riskLevel}]: ${frontendAnalysis.summary}`;

    messages.push({
      messageId: payload.messageId,
      userMessage: payload.content,
      intentType: intent.intentType,
      synthesis,
    });

    // Trim to avoid oversized continueAsNew payload.
    if (messages.length > MAX_RETAINED_MESSAGES) {
      messages = messages.slice(-MAX_RETAINED_MESSAGES);
    }

    // Step 5: human-in-the-loop approval gate for execution intents (or when forced in tests).
    const needsApproval =
      input.alwaysRequireApproval ||
      intent.intentType === 'implement' ||
      intent.intentType === 'deploy';

    if (needsApproval) {
      sessionState = 'awaiting-approval';
      // Use a monotonic counter to handle early-arriving approval signals correctly.
      const requiredApprovals = approvalCount + 1;
      await condition(() => approvalCount >= requiredApprovals);

      if (!input.skipDispatch) {
        await dashboardDispatch({
          workItemId: `session-${input.sessionId}-${payload.messageId}`,
          projectKey: input.projectKey,
          permissionMode: 'acceptEdits',
          additionalInstructions: payload.content,
        });
      }
    }

    sessionState = 'idle';

    // Step 6: continueAsNew when approaching history limit (only when queue is drained).
    if (workflowInfo().historyLength >= threshold && messageQueue.length === 0) {
      await continueAsNew<typeof userSessionWorkflow>({
        ...input,
        continuation: {
          lastMessageId: payload.messageId,
          recentMessages: messages.slice(-MAX_RETAINED_MESSAGES),
          totalMessageCount,
        },
      });
    }
  }
}
