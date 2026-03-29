/**
 * Gemini adapter stub — placeholder for future Google Gemini CLI integration.
 */
export default {
  name: 'gemini',

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
