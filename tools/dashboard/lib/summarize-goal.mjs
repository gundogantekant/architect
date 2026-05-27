export async function summarizeGoal(rawInput) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return firstLineFallback(rawInput);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 32,
        messages: [{
          role: 'user',
          content: `Summarize in 4-6 words as a noun phrase (no period, no quotes): ${rawInput}`,
        }],
      }),
    });
    if (!resp.ok) return firstLineFallback(rawInput);
    const data = await resp.json();
    return data.content?.[0]?.text?.trim() || firstLineFallback(rawInput);
  } catch {
    return firstLineFallback(rawInput);
  } finally {
    clearTimeout(timeout);
  }
}

function firstLineFallback(text) {
  return text.replace(/\r?\n.*/s, '').replace(/\s+/g, ' ').trim().substring(0, 60) || null;
}
