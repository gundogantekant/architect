/**
 * AgentAdapter factory — returns the adapter for the given agent type.
 */
import claude from './claude.mjs';
import shell from './shell.mjs';
import codex from './codex.mjs';
import gemini from './gemini.mjs';

const adapters = { claude, shell, codex, gemini };

export function getAdapter(agentType) {
  const adapter = adapters[agentType];
  if (!adapter) throw new Error(`Unknown agent type: ${agentType}`);
  return adapter;
}
