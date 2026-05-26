'use client';
import type { Conversation } from '@/lib/types';

interface Props { conversations: Conversation[]; }

export function ConversationList({ conversations }: Props) {
  if (conversations.length === 0) {
    return <div className="text-gray-400 text-sm">No conversations yet. Start a new one.</div>;
  }
  return (
    <ul className="space-y-2">
      {conversations.map((conv) => (
        <li key={conv.id}>
          <a
            href={`/chat/${conv.id}`}
            className="block bg-gray-900 hover:bg-gray-800 rounded-lg px-4 py-3 transition-colors"
          >
            <div className="text-sm font-medium">{conv.title ?? 'Untitled conversation'}</div>
            <div className="text-xs text-gray-400 mt-1">
              {new Date(conv.updatedAt).toLocaleDateString()}
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
