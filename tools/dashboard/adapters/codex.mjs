/**
 * Codex adapter stub — placeholder for future OpenAI Codex CLI integration.
 */
export default {
  name: 'codex',

  buildArgs(_sessionId, _flags) {
    return [];
  },

  detectReadiness(_accumulated, chunk) {
    return chunk.length > 0;
  },

  extractSessionId() {
    return null;
  },
};
