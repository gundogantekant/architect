import Anthropic from '@anthropic-ai/sdk';

// Module-level singleton — avoids per-invocation initialization overhead.
const anthropicClient = new Anthropic();

export type IntentType =
  | 'implement'
  | 'review'
  | 'test'
  | 'deploy'
  | 'status'
  | 'explain'
  | 'unknown';

export interface ClassifyIntentInput {
  userMessage: string;
  projectKey: string;
}

export interface SdlcIntent {
  intentType: IntentType;
  parameters: Record<string, string>;
  confidence: number;
  rawMessage: string;
}

const INTENT_TYPES: IntentType[] = [
  'implement', 'review', 'test', 'deploy', 'status', 'explain', 'unknown',
];

function isIntentType(value: unknown): value is IntentType {
  return typeof value === 'string' && INTENT_TYPES.includes(value as IntentType);
}

export async function classifyIntent(input: ClassifyIntentInput): Promise<SdlcIntent> {
  const client = anthropicClient;

  const prompt = `You are an SDLC intent classifier. Classify the user message into exactly one of:
implement, review, test, deploy, status, explain, unknown.

Project: ${input.projectKey}
Message: "${input.userMessage}"

Respond with JSON only (no markdown, no explanation):
{"intentType":"<type>","parameters":{},"confidence":0.0}`;

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_CLASSIFY_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 256,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';

  try {
    const parsed = JSON.parse(text) as { intentType: unknown; parameters: unknown; confidence: unknown };
    return {
      intentType: isIntentType(parsed.intentType) ? parsed.intentType : 'unknown',
      parameters: parsed.parameters && typeof parsed.parameters === 'object'
        ? (parsed.parameters as Record<string, string>)
        : {},
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
      rawMessage: input.userMessage,
    };
  } catch {
    return { intentType: 'unknown', parameters: {}, confidence: 0, rawMessage: input.userMessage };
  }
}
