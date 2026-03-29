/**
 * Shell adapter — wraps a plain shell PTY process.
 * No prompt injection, no session ID detection.
 */
export default {
  name: 'shell',

  buildArgs() {
    return [];
  },

  detectReadiness() {
    return true;
  },

  extractSessionId() {
    return null;
  },
};
