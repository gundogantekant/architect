/**
 * Permission flag construction for claude CLI spawns.
 * Single source of truth for the two permission flags across all arg-builder sites.
 */

export function buildPermissionArgs({ permissionMode, skipPermissions } = {}) {
  const args = ['--permission-mode', permissionMode === 'plan' ? 'plan' : 'acceptEdits'];
  // DECISION: per domain/rules.md → Permission Mode Rules, --dangerously-skip-permissions
  // (≡ bypassPermissions) is never emitted in plan mode — it would defeat plan mode.
  if (permissionMode !== 'plan' && skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  return args;
}
