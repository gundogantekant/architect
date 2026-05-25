'use client';
import { useEffect, useState } from 'react';
import { ConversationList } from '@/components/ConversationList';
import type { Conversation } from '@/lib/types';

export default function ChatPage() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/conversations')
      .then((r) => r.json())
      .then((data) => { setConversations(data); setLoading(false); })
      .catch(() => setLoading(false));
  }, []);

  async function createConversation() {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'New conversation' }),
    });
    const data = await res.json();
    if (data.id) {
      window.location.href = `/chat/${data.id}`;
    }
  }

  return (
    <div className="max-w-2xl mx-auto py-8 px-4">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold">Conversations</h1>
        <button
          onClick={createConversation}
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-medium"
        >
          New conversation
        </button>
      </div>
      {loading ? (
        <div className="text-gray-400">Loading...</div>
      ) : (
        <ConversationList conversations={conversations} />
      )}
    </div>
  );
}
