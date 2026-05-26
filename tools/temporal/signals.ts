// Shared signal definitions — imported by workflows, workers, and client scripts.
// CONSTRAINT: import only from '@temporalio/workflow' — no Node built-ins, no third-party packages.
// This file is bundled into the workflow V8 isolate; any non-deterministic import breaks replay.
import { defineSignal } from '@temporalio/workflow';

export interface UserMessagePayload {
  messageId: string;
  content: string;
}

export interface ApprovalPayload {
  approver: string;
  approved: boolean;
  comment?: string;
}

export const userMessageSignal = defineSignal<[UserMessagePayload]>('user-message');
export const approvalSignal = defineSignal<[ApprovalPayload]>('approval');
