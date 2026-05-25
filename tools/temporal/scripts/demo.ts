import { Client, Connection } from '@temporalio/client';
import { sdlcPipeline, approveWorkItemSignal, workItemStateQuery } from '../workflows/sdlc-pipeline';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = 'sdlc-pipeline';

// Usage: node dist/scripts/demo.js <workItemId> [projectKey]
// Example: node dist/scripts/demo.js W-1207 ticari/architect/main
async function main(): Promise<void> {
  const workItemId = process.argv[2];
  const projectKey = process.argv[3] ?? 'ticari/architect/main';

  if (!workItemId) {
    console.error('Usage: node dist/scripts/demo.js <workItemId> [projectKey]');
    process.exit(1);
  }

  const connection = await Connection.connect({ address: TEMPORAL_ADDRESS });
  const client = new Client({ connection });

  const workflowId = `sdlc-${workItemId}-${Date.now()}`;

  console.log(`[demo] starting workflow ${workflowId}`);
  console.log(`[demo] work item: ${workItemId}  project: ${projectKey}`);
  console.log('[demo] dashboard must be running at http://127.0.0.1:3777');

  const handle = await client.workflow.start(sdlcPipeline, {
    taskQueue: TASK_QUEUE,
    workflowId,
    args: [{
      workItemId,
      projectKey,
      skipReviewGate: true,  // auto-complete for demo purposes
    }],
  });

  console.log(`[demo] workflow started → http://localhost:8233/namespaces/default/workflows/${workflowId}`);

  // Query current state (should be 'open' immediately after start)
  const stateBeforeApproval = await handle.query(workItemStateQuery);
  console.log(`[demo] state before approval: ${stateBeforeApproval}`);

  // Advance past the approval gate (open → ready → in-progress)
  await handle.signal(approveWorkItemSignal, { approver: 'demo-script' });
  console.log('[demo] approval signal sent');

  // Wait for the workflow to complete (in-progress → done via skipReviewGate)
  const result = await handle.result();
  console.log('[demo] workflow completed:', JSON.stringify(result, null, 2));
  console.log(`[demo] dispatch ID: ${result.dispatchId}`);
  console.log(`[demo] dispatch status: ${result.finalStatus}`);
  console.log(`[demo] output lines processed: ${result.outputLineCount}`);
}

main().catch(err => {
  console.error('[demo] failed:', err);
  process.exit(1);
});
