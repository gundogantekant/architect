import Anthropic from '@anthropic-ai/sdk';
import type { RagContext } from './rag-retrieval';

const anthropicClient = new Anthropic();

export interface AnalyzeFrontendInput {
  requirement: string;
  projectKey: string;
  ragContext: RagContext;
}

export interface FrontendAnalysis {
  impactAreas: string[];
  riskLevel: 'low' | 'medium' | 'high';
  recommendations: string[];
  summary: string;
}

const RISK_LEVELS = new Set<string>(['low', 'medium', 'high']);

function toRiskLevel(value: unknown): 'low' | 'medium' | 'high' {
  return typeof value === 'string' && RISK_LEVELS.has(value)
    ? (value as 'low' | 'medium' | 'high')
    : 'low';
}

export async function analyzeFrontendImpact(input: AnalyzeFrontendInput): Promise<FrontendAnalysis> {
  const client = anthropicClient;

  const workItemContext = input.ragContext.backlogItems
    .filter(item => item.project_key === input.projectKey)
    .slice(0, 5)
    .map(item => `- ${item.id}: ${item.title} [${item.status}]`)
    .join('\n');

  const prompt = `Analyze frontend/UI impact for this requirement.

Project: ${input.projectKey}
Requirement: "${input.requirement}"
Recent work items:
${workItemContext || '(none)'}

Respond with JSON only (no markdown):
{"impactAreas":["..."],"riskLevel":"low|medium|high","recommendations":["..."],"summary":"..."}`;

  const response = await client.messages.create({
    model: process.env.ANTHROPIC_ANALYSIS_MODEL ?? 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].type === 'text' ? response.content[0].text.trim() : '{}';

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return {
      impactAreas: Array.isArray(parsed['impactAreas']) ? (parsed['impactAreas'] as string[]) : [],
      riskLevel: toRiskLevel(parsed['riskLevel']),
      recommendations: Array.isArray(parsed['recommendations']) ? (parsed['recommendations'] as string[]) : [],
      summary: typeof parsed['summary'] === 'string' ? parsed['summary'] : '',
    };
  } catch {
    return { impactAreas: [], riskLevel: 'low', recommendations: [], summary: '' };
  }
}
