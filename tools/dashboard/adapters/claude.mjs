/**
 * Claude adapter — wraps the claude CLI PTY process.
 * Provides arg construction, readiness detection, and session ID extraction.
 */
import { buildPermissionArgs } from '../permission-args.mjs';

export default {
  name: 'claude',

  buildArgs(claudeSessionId, flags) {
    const args = flags.resume ? ['--resume', claudeSessionId] : ['--session-id', claudeSessionId];
    args.push(...buildPermissionArgs({ permissionMode: flags.permissionMode, skipPermissions: flags.skipPermissions }));
    if (flags.addDir) args.push('--add-dir', flags.addDir);
    if (flags.agentsJson) args.push('--agents', flags.agentsJson);
    if (flags.model) args.push('--model', flags.model);
    return args;
  },

  detectReadiness(accumulated, chunk) {
    // Wait for Claude's TUI to enable bracketed paste mode before injecting.
    // \x1b[?2004h is sent by Ink after mounting; injecting on \x1b[?1049h
    // (alternate screen enter) is too early — Ink hasn't yet activated its
    // input handler, so each \n in the prompt fires as Enter and fragments
    // the prompt into many separate turns.
    // Falls back to the 5-8s timeout in terminal-session.mjs if never seen.
    // May appear multiple times per session (e.g. after resize); the
    // _readyForPrompt flag and _pendingPrompt null-check prevent re-injection.
    const combined = (accumulated || '') + chunk;
    return combined.includes('\x1b[?2004h');
  },

  // Milliseconds to wait after readiness fires before calling injectPrompt.
  // \x1b[?2004h fires at the moment Ink activates bracketed paste, but its
  // event loop tick may not have fully completed. 300ms is generous on
  // developer hardware and well within the 5-8s fallback window.
  injectionDelay: 300,

  extractSessionId(_accumulated, chunk) {
    const match = chunk.match(/"session_id"\s*:\s*"([0-9a-f-]{36})"/);
    return match ? match[1] : null;
  },
};
