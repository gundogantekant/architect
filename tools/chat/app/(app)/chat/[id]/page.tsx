'use client';
import { useEffect, useState, useCallback } from 'react';
import { MessageThread } from '@/components/MessageThread';
import { WorkflowStatusIndicator } from '@/components/WorkflowStatusIndicator';
import { EscalationBanner } from '@/components/EscalationBanner';
import { ApprovalGate } from '@/components/ApprovalGate';
import { WorkflowStateProvider } from '@/components/WorkflowStateContext';
import type { Message } from '@/lib/types';

interface PageProps { params: { id: string }; }

export default function ConversationPage({ params }: PageProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/conversations/${params.id}`)
      .then((r) => r.json())
      .then((data) => setMessages(data.messages ?? []));
  }, [params.id]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || submitting) return;
    setSubmitting(true);
    const content = input.trim();
    setInput('');

    const optimisticId = `optimistic-${Date.now()}`;
    setMessages((prev) => [...prev, {
      id: optimisticId,
      conversationId: params.id,
      role: 'user' as const,
      content,
      createdAt: new Date().toISOString(),
    }]);

    await fetch(`/api/conversations/${params.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    setSubmitting(false);
  }, [input, submitting, params.id]);

  const onNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  return (
    <WorkflowStateProvider conversationId={params.id}>
      <div className="flex flex-col h-screen max-w-3xl mx-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
          <a href="/chat" className="text-gray-400 hover:text-white text-sm">← Back</a>
          <WorkflowStatusIndicator />
        </div>
        <EscalationBanner conversationId={params.id} />
        <ApprovalGate conversationId={params.id} />
        <MessageThread messages={messages} conversationId={params.id} onNewMessage={onNewMessage} />
        <div className="border-t border-gray-800 p-4 flex gap-3">
          <textarea
            className="flex-1 bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-sm resize-none focus:outline-none focus:border-blue-500"
            rows={3}
            placeholder="Send a message..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          />
          <button
            onClick={sendMessage}
            disabled={submitting || !input.trim()}
            className="bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 text-white px-4 rounded-lg text-sm font-medium self-end"
          >
            Send
          </button>
        </div>
      </div>
    </WorkflowStateProvider>
  );
}
