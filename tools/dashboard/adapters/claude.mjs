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
    if (flags.model) args.push('--model', flags.model);
    return args;
  },

  detectReadiness(accumulated, chunk) {
    // Wait for Claude's TUI to enter the alternate screen buffer before
    // injecting the prompt. The sequence \x1b[?1049h signals that the TUI
    // is rendering and ready to accept input. Falls back to the server-side
    // timeout (5-8s) if the sequence is never seen.
    const combined = (accumulated || '') + chunk;
    return combined.includes('\x1b[?1049h');
  },

  extractSessionId(_accumulated, chunk) {
    const match = chunk.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/);
    return match ? match[1] : null;
  },
};
