// Session worker — registers UserSessionWorkflow and all its activities.
// Task queue: 'user-session'  |  Namespace: 'architect' (registered by W-1210 setup)
//
// Start: npm run session-worker
// Requires: temporal server running with namespace 'architect' pre-registered.
//   Full Postgres: source tools/temporal/config/.env && temporal server start-dev \
//     --config tools/temporal/config/development.yaml --namespace architect
//   Dev mode (no Postgres): temporal server start-dev --namespace architect
import { Worker, NativeConnection } from '@temporalio/worker';
import { join } from 'path';
import * as classifyIntentActivities from '../activities/classify-intent';
import * as ragRetrievalActivities from '../activities/rag-retrieval';
import * as analyzeCloudActivities from '../activities/analyze-cloud';
import * as analyzeFrontendActivities from '../activities/analyze-frontend';
import * as dispatchAgentActivities from '../activities/dispatch-agent';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = 'user-session';
const NAMESPACE = 'architect';

function validateEnvironment(): void {
  const missingVars: string[] = [];
  if (!process.env.ANTHROPIC_API_KEY) missingVars.push('ANTHROPIC_API_KEY');
  if (missingVars.length > 0) {
    console.error(`[session-worker] missing required env vars: ${missingVars.join(', ')}`);
    console.error('[session-worker] copy tools/temporal/config/.env.example → .env and fill in values');
    process.exit(1);
  }
}

// workflowsPath resolves after `npm run build` (tsc).
// At runtime __dirname is dist/workers/, expanding to dist/workflows/user-session.js.
// The invariant depends on tsconfig.json keeping rootDir:"." and outDir:"dist" unchanged.
const workflowsPath = join(__dirname, '..', 'workflows', 'user-session.js');

async function main(): Promise<void> {
  validateEnvironment();
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  const worker = await Worker.create({
    connection,
    namespace: NAMESPACE,
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities: {
      ...classifyIntentActivities,
      ...ragRetrievalActivities,
      ...analyzeCloudActivities,
      ...analyzeFrontendActivities,
      ...dispatchAgentActivities,
    },
  });

  console.log(`[session-worker] starting`);
  console.log(`[session-worker]   namespace : ${NAMESPACE}`);
  console.log(`[session-worker]   task queue: ${TASK_QUEUE}`);
  console.log(`[session-worker]   temporal  : ${TEMPORAL_ADDRESS}`);
  console.log('[session-worker]   Web UI    : http://localhost:8233');
  console.log('[session-worker] env: ARCHITECT_PORTFOLIO_DIR =', process.env.ARCHITECT_PORTFOLIO_DIR ?? '(not set)');

  await worker.run();
}

main().catch(err => {
  console.error('[session-worker] fatal:', err);
  process.exit(1);
});
