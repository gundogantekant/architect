// Pure status-classification helpers for process-exit handlers.
// IMPORTANT: this module must remain import-free — it is loaded by node --test
// unit runs that cannot tolerate heavy side-effects (DB, pty, child processes).

/**
 * Classify how a dispatch's proc.on('close') should resolve.
 *
 * @param {object} dispatch - in-memory dispatch record
 * @param {number|null} code - process exit code
 * @returns {{ status: string, exit_type: string|null, preserve: boolean }}
 *   When preserve is true the caller must skip status/exit_type overwrites,
 *   release resources, and return early (mirror of the _mergeHandled pattern).
 *   Intentional omission: the suspended path does NOT write exit_type to DB —
 *   no existing bucket (graceful/killed/timeout/interrupted) describes a
 *   process that exited because it was gracefully suspended.
 */
export function classifyDispatchClose(dispatch, code) {
  if (dispatch.status === 'suspended') {
    return { status: 'suspended', exit_type: dispatch.exit_type ?? null, preserve: true };
  }

  let exit_type;
  if (dispatch._killedIntentionally) {
    exit_type = 'killed';
  } else if (dispatch._timedOut) {
    exit_type = 'timeout';
  } else if (code === 0) {
    exit_type = 'graceful';
  } else {
    exit_type = 'interrupted';
  }

  const status = (dispatch._gracefulInterrupt && !dispatch._killedIntentionally)
    ? 'interrupted'
    : (code === 0 ? 'completed' : 'failed');

  return { status, exit_type, preserve: false };
}

/**
 * Classify how a terminal's ptyProcess.onExit should resolve.
 *
 * @param {string} currentStatus - terminal.status at the time onExit fires
 * @param {number} exitCode - PTY exit code
 * @returns {{ status: string, preserve: boolean }}
 *   When preserve is true the caller must skip the status overwrite, meta
 *   status event, exit broadcast, tmux kill, archiveSession, and
 *   saveTerminalToDb — the suspend endpoint already performed all of these
 *   synchronously before onExit could fire.
 */
export function classifyTerminalExit(currentStatus, exitCode) {
  if (currentStatus === 'suspended') {
    return { status: 'suspended', preserve: true };
  }
  return { status: exitCode === 0 ? 'completed' : 'failed', preserve: false };
}
