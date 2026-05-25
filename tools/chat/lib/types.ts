// Signal names — must match tools/temporal/signals.ts
export const SIGNAL_USER_MESSAGE = 'user-message';
export const SIGNAL_APPROVAL = 'approval';

// Query name — must match tools/temporal/queries.ts
export const QUERY_SESSION_STATE = 'session-state';

// Temporal workflow task queue and namespace
export const TEMPORAL_TASK_QUEUE = 'user-session';
export const TEMPORAL_NAMESPACE = 'architect';
export const TEMPORAL_WORKFLOW_TYPE = 'userSessionWorkflow';
export const DEFAULT_PROJECT_KEY = 'ticari/architect/main';

export type SessionState = 'idle' | 'processing' | 'awaiting-approval' | 'done';

export interface SessionSnapshot {
  sessionId: string;
  sessionState: SessionState;
  messageCount: number;
  historyLength: number;
}

export interface UserMessagePayload {
  messageId: string;
  content: string;
}

export interface ApprovalPayload {
  approver: string;
  approved: boolean;
  comment?: string;
}

export interface Conversation {
  id: string;
  userSub: string;
  title: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  costUsd?: string;
}

export interface TokenCost {
  messageId: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
  costUsd: string;
}

export interface SessionStatusResponse {
  sessionId: string;
  sessionState: SessionState;
  messageCount: number;
}

export interface SendSignalRequest {
  signalType: 'approval' | 'extend';
  payload?: {
    approved?: boolean;
    comment?: string;
  };
}
