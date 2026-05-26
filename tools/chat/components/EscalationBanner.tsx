'use client';
import { useEffect, useState } from 'react';

interface Props { conversationId: string; }

export function EscalationBanner({ conversationId }: Props) {
  const [visible, setVisible] = useState(false);
  const [extending, setExtending] = useState(false);

  useEffect(() => {
    const handler = (e: CustomEvent) => {
      if (e.detail?.event === 'idle' && e.detail?.conversationId === conversationId) {
        setVisible(true);
      }
    };
    window.addEventListener('timeout_warning', handler as EventListener);
    return () => window.removeEventListener('timeout_warning', handler as EventListener);
  }, [conversationId]);

  async function handleExtend() {
    setExtending(true);
    try {
      await fetch(`/api/conversations/${conversationId}/signal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signalType: 'extend' }),
      });
      setVisible(false);
    } finally {
      setExtending(false);
    }
  }

  if (!visible) return null;

  return (
    <div className="mx-4 my-2 bg-yellow-900 border border-yellow-600 rounded-lg px-4 py-3 flex items-center justify-between">
      <span className="text-sm text-yellow-200">
        Session is idle. Extend to continue where you left off.
      </span>
      <button
        onClick={handleExtend}
        disabled={extending}
        className="ml-4 bg-yellow-600 hover:bg-yellow-500 disabled:bg-gray-600 text-white text-xs font-medium px-3 py-1.5 rounded"
      >
        {extending ? 'Extending...' : 'Extend'}
      </button>
    </div>
  );
}
