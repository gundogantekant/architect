import { Worker, NativeConnection } from '@temporalio/worker';
import { join } from 'path';
import * as activities from '../activities/dispatch-agent';

const TEMPORAL_ADDRESS = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
const TASK_QUEUE = 'sdlc-pipeline';

async function main(): Promise<void> {
  const connection = await NativeConnection.connect({ address: TEMPORAL_ADDRESS });

  // workflowsPath resolves correctly only after `npm run build` (tsc).
  // At runtime __dirname is dist/workers/, so this expands to dist/workflows/sdlc-pipeline.js.
  // The invariant depends on tsconfig.json keeping rootDir:"." and outDir:"dist" unchanged.
  // Temporal bundles the resolved JS in a V8 isolate via webpack.
  const workflowsPath = join(__dirname, '..', 'workflows', 'sdlc-pipeline.js');

  const worker = await Worker.create({
    connection,
    namespace: 'default',
    taskQueue: TASK_QUEUE,
    workflowsPath,
    activities,
  });

  console.log(`[worker] starting on task queue "${TASK_QUEUE}" → ${TEMPORAL_ADDRESS}`);
  console.log('[worker] Temporal Web UI: http://localhost:8233');

  await worker.run();
}

main().catch(err => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
