// Shared query definitions — imported by workflows, workers, and client scripts.
// CONSTRAINT: import only from '@temporalio/workflow' — no Node built-ins, no third-party packages.
// This file is bundled into the workflow V8 isolate; any non-deterministic import breaks replay.
import { defineQuery } from '@temporalio/workflow';

export type SessionState = 'idle' | 'processing' | 'awaiting-approval' | 'done';

export interface SessionSnapshot {
  sessionId: string;
  sessionState: SessionState;
  messageCount: number;
  historyLength: number;
}

export const sessionStateQuery = defineQuery<SessionSnapshot>('session-state');
