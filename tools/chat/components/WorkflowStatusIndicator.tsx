'use client';
import { useWorkflowState } from './WorkflowStateContext';
import type { SessionState } from '@/lib/types';

const stateLabels: Record<SessionState, string> = {
  idle: 'Idle',
  processing: 'Processing...',
  'awaiting-approval': 'Waiting for approval',
  done: 'Done',
};

const stateColors: Record<SessionState, string> = {
  idle: 'bg-gray-600',
  processing: 'bg-blue-500 animate-pulse',
  'awaiting-approval': 'bg-yellow-500',
  done: 'bg-green-600',
};

export function WorkflowStatusIndicator() {
  const { sessionState } = useWorkflowState();
  return (
    <div className="flex items-center gap-2">
      <span className={`w-2 h-2 rounded-full ${stateColors[sessionState]}`} />
      <span className="text-xs text-gray-400">{stateLabels[sessionState]}</span>
    </div>
  );
}
