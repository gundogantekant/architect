'use client';
import { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import type { SessionState } from '@/lib/types';

interface WorkflowState {
  sessionState: SessionState;
  lastMessage: { id: string; content: string; createdAt: string } | null;
  awaitingApproval: boolean;
}

const defaultState: WorkflowState = {
  sessionState: 'idle',
  lastMessage: null,
  awaitingApproval: false,
};

export const WorkflowStateContext = createContext<WorkflowState>(defaultState);

export function useWorkflowState() {
  return useContext(WorkflowStateContext);
}

interface ProviderProps {
  conversationId: string;
  children: ReactNode;
}

export function WorkflowStateProvider({ conversationId, children }: ProviderProps) {
  const [state, setState] = useState<WorkflowState>(defaultState);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let mounted = true;
    let retryCount = 0;

    function connect() {
      eventSource = new EventSource(`/api/conversations/${conversationId}/stream`);

      eventSource.addEventListener('status', (e) => {
        if (!mounted) return;
        retryCount = 0;
        const data = JSON.parse((e as MessageEvent).data);
        setState((prev) => ({ ...prev, sessionState: data.sessionState }));
      });

      eventSource.addEventListener('message', (e) => {
        if (!mounted) return;
        const data = JSON.parse((e as MessageEvent).data);
        setState((prev) => ({ ...prev, lastMessage: data, sessionState: 'idle' }));
      });

      eventSource.addEventListener('approval-required', () => {
        if (!mounted) return;
        setState((prev) => ({ ...prev, awaitingApproval: true, sessionState: 'awaiting-approval' }));
      });

      eventSource.addEventListener('idle', () => {
        if (!mounted) return;
        setState((prev) => ({ ...prev, sessionState: 'idle', awaitingApproval: false }));
      });

      eventSource.addEventListener('timeout', (e) => {
        if (!mounted) return;
        const data = JSON.parse((e as MessageEvent).data);
        window.dispatchEvent(new CustomEvent('timeout_warning', {
          detail: { event: 'idle', conversationId: data.conversationId ?? conversationId }
        }));
      });

      eventSource.addEventListener('error', () => {
        eventSource?.close();
        if (!mounted) return;
        const backoffMs = Math.min(1000 * Math.pow(2, retryCount), 30_000);
        retryCount++;
        setTimeout(() => { if (mounted) connect(); }, backoffMs);
      });
    }

    connect();
    return () => {
      mounted = false;
      eventSource?.close();
    };
  }, [conversationId]);

  return (
    <WorkflowStateContext.Provider value={state}>
      {children}
    </WorkflowStateContext.Provider>
  );
}
