const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5-20251001';
const REQUEST_TIMEOUT_MS = 5000;
const MAX_TOKENS = 256;

function buildOptionsBlock(options) {
  return (options || [])
    .map(opt => `${opt.n}. ${opt.label}`)
    .join('\n');
}

async function callHaiku(content, { fetchImpl, apiKey }) {
  if (!apiKey) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetchImpl(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        messages: [{ role: 'user', content }],
      }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return parseJsonReply(data?.content?.[0]?.text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function parseJsonReply(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function explainPrompt({ prompt, options, projectKey, workItemId }) {
  const header = [
    projectKey ? `Project: ${projectKey}` : null,
    workItemId ? `Work item: ${workItemId}` : null,
  ].filter(Boolean).join('\n');
  return [
    'An automated coding agent is asking a human a question and waiting for an answer.',
    header,
    'Question prompt:',
    prompt || '(none)',
    'Provided options (number. label):',
    buildOptionsBlock(options),
    'Respond ONLY as JSON of the shape:',
    '{"summary": "<1-2 sentence plain-language explanation of what is being asked and why>",',
    ' "options": [{"n": <number>, "label": "<original label>", "blurb": "<short readable restatement>"}]}',
    'Preserve each option number n exactly as given. No prose outside the JSON.',
  ].filter(Boolean).join('\n\n');
}

export async function explainQuestion(
  { prompt, options, projectKey, workItemId },
  { fetchImpl = globalThis.fetch, apiKey = process.env.ANTHROPIC_API_KEY } = {},
) {
  const reply = await callHaiku(
    explainPrompt({ prompt, options, projectKey, workItemId }),
    { fetchImpl, apiKey },
  );
  if (!reply || typeof reply.summary !== 'string' || !Array.isArray(reply.options)) {
    return null;
  }
  return { summary: reply.summary, options: reply.options };
}

function matchOptionDeterministically(userText, options) {
  const trimmed = (userText || '').trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    const byNumber = (options || []).find(opt => opt.n === n);
    if (byNumber) return { type: 'option', index: byNumber.n };
  }
  const lower = trimmed.toLowerCase();
  const labelMatches = (options || []).filter(opt => {
    const label = String(opt.label || '').toLowerCase();
    return label !== '' && (label === lower || label.includes(lower) || lower.includes(label));
  });
  if (labelMatches.length === 1) return { type: 'option', index: labelMatches[0].n };
  return null;
}

function mapPrompt(userText, { prompt, options }) {
  return [
    'An automated coding agent asked a human a question. Map the human reply to a decision.',
    'Question prompt:',
    prompt || '(none)',
    'Available options (number. label):',
    buildOptionsBlock(options),
    'Human reply:',
    userText,
    'Respond ONLY as JSON. If the reply selects one option, use {"type":"option","index":<n>}.',
    'If the reply is a freeform answer not matching an option, use {"type":"text","value":"<answer>"}.',
    'No prose outside the JSON.',
  ].join('\n\n');
}

function normalizeDecision(reply, options) {
  if (!reply) return { type: 'unclear' };
  if (reply.type === 'option') {
    const match = (options || []).find(opt => opt.n === reply.index);
    if (match) return { type: 'option', index: match.n };
    return { type: 'unclear' };
  }
  if (reply.type === 'text' && typeof reply.value === 'string') {
    return { type: 'text', value: reply.value };
  }
  return { type: 'unclear' };
}

export async function mapReplyToDecision(
  userText,
  { prompt, options },
  { fetchImpl = globalThis.fetch, apiKey = process.env.ANTHROPIC_API_KEY } = {},
) {
  const deterministic = matchOptionDeterministically(userText, options);
  if (deterministic) return deterministic;
  if (!apiKey || !(options && options.length)) return { type: 'unclear' };
  const reply = await callHaiku(mapPrompt(userText, { prompt, options }), { fetchImpl, apiKey });
  return normalizeDecision(reply, options);
}
