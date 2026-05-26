'use client';
import { useWorkflowState } from './WorkflowStateContext';

interface Props { conversationId: string; }

export function ApprovalGate({ conversationId }: Props) {
  const { awaitingApproval } = useWorkflowState();

  if (!awaitingApproval) return null;

  async function approve() {
    await fetch(`/api/conversations/${conversationId}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalType: 'approval', payload: { approved: true } }),
    });
  }

  async function reject() {
    await fetch(`/api/conversations/${conversationId}/signal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signalType: 'approval', payload: { approved: false } }),
    });
  }

  return (
    <div className="mx-4 my-2 bg-indigo-900 border border-indigo-600 rounded-lg px-4 py-4">
      <p className="text-sm text-indigo-200 mb-3">
        This action requires your approval before the agent proceeds.
      </p>
      <div className="flex gap-3">
        <button
          onClick={approve}
          className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium px-4 py-2 rounded-lg"
        >
          Approve
        </button>
        <button
          onClick={reject}
          className="bg-gray-700 hover:bg-gray-600 text-white text-sm font-medium px-4 py-2 rounded-lg"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
