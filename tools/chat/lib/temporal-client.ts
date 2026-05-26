import { Client, Connection, WorkflowHandle } from '@temporalio/client';
import {
  TEMPORAL_NAMESPACE,
  TEMPORAL_TASK_QUEUE,
  TEMPORAL_WORKFLOW_TYPE,
  DEFAULT_PROJECT_KEY,
  SIGNAL_USER_MESSAGE,
  SIGNAL_APPROVAL,
  QUERY_SESSION_STATE,
  SessionSnapshot,
  UserMessagePayload,
  ApprovalPayload,
} from './types';

let clientPromise: Promise<Client> | null = null;

function getClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = Connection.connect({
      address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
    }).then(
      (connection) => new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? TEMPORAL_NAMESPACE })
    ).catch((error) => {
      clientPromise = null;
      throw new Error(
        `Temporal offline: cannot connect to ${process.env.TEMPORAL_ADDRESS ?? 'localhost:7233'}. ` +
        `Start Temporal with: temporal server start-dev --namespace architect. ` +
        `Original error: ${error instanceof Error ? error.message : String(error)}`
      );
    });
  }
  return clientPromise;
}

export async function startConversationWorkflow(conversationId: string, userId: string): Promise<void> {
  const client = await getClient();
  await client.workflow.start(TEMPORAL_WORKFLOW_TYPE, {
    taskQueue: TEMPORAL_TASK_QUEUE,
    workflowId: conversationId,
    args: [{
      sessionId: conversationId,
      userId,
      projectKey: DEFAULT_PROJECT_KEY,
    }],
  });
}

export async function sendUserMessage(conversationId: string, payload: UserMessagePayload): Promise<void> {
  const client = await getClient();
  const handle: WorkflowHandle = client.workflow.getHandle(conversationId);
  await handle.signal(SIGNAL_USER_MESSAGE, payload);
}

export async function sendApproval(conversationId: string, payload: ApprovalPayload): Promise<void> {
  const client = await getClient();
  const handle: WorkflowHandle = client.workflow.getHandle(conversationId);
  await handle.signal(SIGNAL_APPROVAL, payload);
}

export async function getConversationState(conversationId: string): Promise<SessionSnapshot> {
  const client = await getClient();
  const handle: WorkflowHandle = client.workflow.getHandle(conversationId);
  return handle.query<SessionSnapshot>(QUERY_SESSION_STATE);
}
