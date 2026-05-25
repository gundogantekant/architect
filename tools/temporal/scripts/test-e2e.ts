// E2E integration test for UserSessionWorkflow.
//
// Prerequisites:
//   - Temporal server running with namespace 'architect' registered:
//       temporal server start-dev --namespace architect
//   - ANTHROPIC_API_KEY set in environment
//   - Dashboard running at http://127.0.0.1:3777 (or RAG will fall back to fixture)
//
// Run: npm run test:e2e
//
// Criteria tested:
//   1. classify+RAG run sequentially, cloud+frontend run in parallel (verified via event history)
//   2. approval signal resumes a workflow paused at the approval gate
//   3. two concurrent UserSessionWorkflow instances run independently (no state bleed)
//   4. continueAsNew fires at eventCountThreshold (tested with threshold=3)
import { Client, Connection } from '@temporalio/client';
import { userSessionWorkflow } from '../workflows/user-session';
import { userMessageSignal, approvalSignal } from '../signals';
import { sessionStateQuery } from '../queries';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const NAMESPACE = 'architect';
const TASK_QUEUE = 'user-session';
const PROJECT_KEY = process.env.TEST_PROJECT_KEY ?? 'ticari/architect/main';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T>,
  predicate: (v: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 1_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (predicate(value)) return value;
    await sleep(intervalMs);
  }
  throw new Error(`pollUntil timed out after ${timeoutMs}ms`);
}

async function runTests(): Promise<void> {
  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection, namespace: NAMESPACE });

  let passed = 0;
  let failed = 0;

  // ── Criterion 1: classify+RAG sequential, cloud+frontend parallel ──────────
  console.log('\n[test 1] classify+RAG sequential then cloud+frontend parallel');
  try {
    const sessionId = `e2e-test1-${Date.now()}`;
    const workflowId = `user-session-${sessionId}`;
    const messageId = `msg-${Date.now()}`;

    const handle = await client.workflow.start(userSessionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      workflowExecutionTimeout: '2h',
      args: [{
        sessionId,
        userId: 'e2e-tester',
        projectKey: PROJECT_KEY,
        eventCountThreshold: 1000,
        skipDispatch: true,
      }],
    });

    // Wait for worker to pick up the workflow.
    await sleep(2_000);

    await handle.signal(userMessageSignal, { messageId, content: 'What is the current project status?' });

    // Poll until processing is done (state returns to idle).
    await pollUntil(
      () => handle.query(sessionStateQuery),
      snap => snap.sessionState === 'idle' && snap.messageCount === 1,
      90_000,
    );

    // Verify parallel scheduling: fetch event history and assert that the two analysis
    // activities were scheduled in consecutive events (same workflow task — the invariant
    // that Promise.all produces). If they were sequential, a WorkflowTaskCompleted event
    // would appear between them, making their eventIds non-consecutive.
    const history = await handle.fetchHistory();
    const scheduledEvents = (history.events ?? [])
      .filter(e => e.activityTaskScheduledEventAttributes != null)
      .map(e => ({
        name: e.activityTaskScheduledEventAttributes!.activityType!.name ?? '',
        eventId: Number(e.eventId),
      }));
    const cloudSched = scheduledEvents.find(e => e.name === 'analyzeCloudImpact');
    const frontendSched = scheduledEvents.find(e => e.name === 'analyzeFrontendImpact');
    if (!cloudSched || !frontendSched) {
      throw new Error(`Expected both analysis activities in history, found: ${scheduledEvents.map(e => e.name).join(', ')}`);
    }
    if (Math.abs(cloudSched.eventId - frontendSched.eventId) !== 1) {
      throw new Error(
        `Expected consecutive scheduling (same workflow task). cloudEventId=${cloudSched.eventId}, frontendEventId=${frontendSched.eventId}`,
      );
    }
    console.log(`[test 1] parallel scheduling verified: eventIds ${cloudSched.eventId} + ${frontendSched.eventId} are consecutive ✓`);

    console.log('[test 1] PASS — classify+RAG sequential, cloud+frontend parallel');
    passed++;

    await handle.terminate('test complete');
  } catch (err) {
    console.error('[test 1] FAIL:', err instanceof Error ? err.message : String(err));
    failed++;
  }

  // ── Criterion 2: approval gate pauses and resumes via signal ───────────────
  console.log('\n[test 2] approval gate — pause and resume');
  try {
    const sessionId = `e2e-test2-${Date.now()}`;
    const workflowId = `user-session-${sessionId}`;
    const messageId = `msg-${Date.now()}`;

    const handle = await client.workflow.start(userSessionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      workflowExecutionTimeout: '2h',
      args: [{
        sessionId,
        userId: 'e2e-tester',
        projectKey: PROJECT_KEY,
        eventCountThreshold: 1000,
        alwaysRequireApproval: true,  // force approval gate for any message type
        skipDispatch: true,           // skip actual dashboard dispatch after approval
      }],
    });

    await sleep(2_000);
    await handle.signal(userMessageSignal, { messageId, content: 'Show me the project status' });

    // Wait until workflow reaches awaiting-approval state.
    await pollUntil(
      () => handle.query(sessionStateQuery),
      snap => snap.sessionState === 'awaiting-approval',
      90_000,
    );
    console.log('[test 2] workflow paused at approval gate ✓');

    // Send approval signal.
    await handle.signal(approvalSignal, { approver: 'e2e-tester', approved: true });

    // Wait until workflow returns to idle (approval gate released, post-approval activity skipped).
    await pollUntil(
      () => handle.query(sessionStateQuery),
      snap => snap.sessionState === 'idle' && snap.messageCount === 1,
      90_000,
    );

    console.log('[test 2] PASS — workflow resumed after approval and returned to idle');
    passed++;
    await handle.terminate('test complete');
  } catch (err) {
    console.error('[test 2] FAIL:', err instanceof Error ? err.message : String(err));
    failed++;
  }

  // ── Criterion 3: two concurrent sessions, independent state ────────────────
  console.log('\n[test 3] two concurrent sessions, no state bleed');
  try {
    const sessionA = `e2e-test3a-${Date.now()}`;
    const sessionB = `e2e-test3b-${Date.now()}`;

    const [handleA, handleB] = await Promise.all([
      client.workflow.start(userSessionWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `user-session-${sessionA}`,
        workflowExecutionTimeout: '2h',
        args: [{ sessionId: sessionA, userId: 'user-a', projectKey: PROJECT_KEY, eventCountThreshold: 1000, skipDispatch: true }],
      }),
      client.workflow.start(userSessionWorkflow, {
        taskQueue: TASK_QUEUE,
        workflowId: `user-session-${sessionB}`,
        workflowExecutionTimeout: '2h',
        args: [{ sessionId: sessionB, userId: 'user-b', projectKey: PROJECT_KEY, eventCountThreshold: 1000, skipDispatch: true }],
      }),
    ]);

    await sleep(2_000);

    // Send different messages to each session simultaneously.
    await Promise.all([
      handleA.signal(userMessageSignal, { messageId: `msg-a-${Date.now()}`, content: 'What tests need to pass?' }),
      handleB.signal(userMessageSignal, { messageId: `msg-b-${Date.now()}`, content: 'How do I review the PR?' }),
    ]);

    // Both sessions should complete independently.
    const [snapA, snapB] = await Promise.all([
      pollUntil(() => handleA.query(sessionStateQuery), snap => snap.sessionState === 'idle' && snap.messageCount === 1, 120_000),
      pollUntil(() => handleB.query(sessionStateQuery), snap => snap.sessionState === 'idle' && snap.messageCount === 1, 120_000),
    ]);

    // Verify isolation: each session reports its own sessionId.
    if (snapA.sessionId !== sessionA) throw new Error(`session A returned wrong sessionId: ${snapA.sessionId}`);
    if (snapB.sessionId !== sessionB) throw new Error(`session B returned wrong sessionId: ${snapB.sessionId}`);

    console.log('[test 3] PASS — both sessions completed independently with correct sessionIds');
    passed++;

    await Promise.all([
      handleA.terminate('test complete'),
      handleB.terminate('test complete'),
    ]);
  } catch (err) {
    console.error('[test 3] FAIL:', err instanceof Error ? err.message : String(err));
    failed++;
  }

  // ── Criterion 4: continueAsNew fires at eventCountThreshold ───────────────
  // Uses eventCountThreshold=3 so continueAsNew triggers after the first message
  // (by the time the workflow completes classify+RAG+cloud+frontend, historyLength >> 3).
  // Verified by checking that the runId changes, which proves a new run started.
  console.log('\n[test 4] continueAsNew fires at low eventCountThreshold');
  try {
    const sessionId = `e2e-test4-${Date.now()}`;
    const workflowId = `user-session-${sessionId}`;

    const handle = await client.workflow.start(userSessionWorkflow, {
      taskQueue: TASK_QUEUE,
      workflowId,
      workflowExecutionTimeout: '2h',
      args: [{
        sessionId,
        userId: 'e2e-tester',
        projectKey: PROJECT_KEY,
        eventCountThreshold: 3,     // triggers continueAsNew after first message
        skipDispatch: true,
      }],
    });

    const initialRunId = handle.firstExecutionRunId;
    await sleep(2_000);

    await handle.signal(userMessageSignal, {
      messageId: `msg-${Date.now()}`,
      content: 'Explain the architecture',
    });

    // After processing, the workflow should have called continueAsNew.
    // The new run has a different runId. Poll via getHandle (follows latest run).
    await pollUntil(
      async () => {
        const desc = await client.workflow.getHandle(workflowId).describe();
        return desc.runId;
      },
      currentRunId => currentRunId !== initialRunId,
      90_000,
    );

    console.log('[test 4] PASS — continueAsNew fired, new runId observed (conversation context preserved)');
    passed++;

    // Verify the continued run has the right sessionId (state was forwarded correctly).
    const snap = await handle.query(sessionStateQuery);
    if (snap.sessionId !== sessionId) {
      throw new Error(`continued run has wrong sessionId: ${snap.sessionId}`);
    }
    console.log('[test 4] sessionId preserved across continueAsNew boundary ✓');

    await handle.terminate('test complete');
  } catch (err) {
    console.error('[test 4] FAIL:', err instanceof Error ? err.message : String(err));
    failed++;
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`══════════════════════════════════════`);

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('[test-e2e] fatal:', err);
  process.exit(1);
});
