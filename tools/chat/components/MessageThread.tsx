'use client';
import { useEffect } from 'react';
import { useWorkflowState } from './WorkflowStateContext';
import { TokenCostBadge } from './TokenCostBadge';
import type { Message } from '@/lib/types';

interface Props {
  messages: Message[];
  conversationId: string;
  onNewMessage: (msg: Message) => void;
}

export function MessageThread({ messages, conversationId, onNewMessage }: Props) {
  const { lastMessage, sessionState } = useWorkflowState();

  useEffect(() => {
    if (lastMessage) {
      onNewMessage({
        id: lastMessage.id,
        conversationId,
        role: 'assistant',
        content: lastMessage.content,
        createdAt: lastMessage.createdAt,
      });
    }
  }, [lastMessage, conversationId, onNewMessage]);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 space-y-4">
      {messages.map((msg) => (
        <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          <div
            data-role={msg.role}
            className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm ${
              msg.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-800 text-gray-100'
            }`}
          >
            <p className="whitespace-pre-wrap">{msg.content}</p>
            {msg.role === 'assistant' && (
              <div className="mt-2">
                <TokenCostBadge messageId={msg.id} />
              </div>
            )}
          </div>
        </div>
      ))}
      {sessionState === 'processing' && (
        <div className="flex justify-start">
          <div className="bg-gray-800 rounded-2xl px-4 py-3 text-sm text-gray-400">
            <span className="animate-pulse">Thinking...</span>
          </div>
        </div>
      )}
    </div>
  );
}
