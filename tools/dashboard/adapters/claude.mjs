/**
 * Claude adapter — wraps the claude CLI PTY process.
 * Provides arg construction, readiness detection, and session ID extraction.
 */
export default {
  name: 'claude',

  buildArgs(claudeSessionId, flags) {
    const args = ['--session-id', claudeSessionId];
    if (flags.permissionMode === 'plan') {
      args.push('--permission-mode', 'plan');
    } else {
      args.push('--permission-mode', 'acceptEdits');
    }
    if (flags.skipPermissions) args.push('--dangerously-skip-permissions');
    if (flags.addDir) args.push('--add-dir', flags.addDir);
    if (flags.agentsJson) args.push('--agents', flags.agentsJson);
    return args;
  },

  detectReadiness(_accumulated, chunk) {
    return chunk.length > 0;
  },

  extractSessionId(_accumulated, chunk) {
    const match = chunk.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/);
    return match ? match[1] : null;
  },
};
