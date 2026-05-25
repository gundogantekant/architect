'use client';
import { useEffect, useState } from 'react';
import type { TokenCost } from '@/lib/types';

interface Props { messageId: string; }

export function TokenCostBadge({ messageId }: Props) {
  const [cost, setCost] = useState<TokenCost | null>(null);

  useEffect(() => {
    fetch(`/api/messages/${messageId}/cost`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data) setCost(data); })
      .catch(() => {});
  }, [messageId]);

  if (!cost) return null;

  const costFormatted = parseFloat(cost.costUsd).toFixed(6);
  return (
    <span className="text-xs text-gray-500">
      ${costFormatted} · {cost.model} · {cost.inputTokens + cost.outputTokens} tokens
    </span>
  );
}
