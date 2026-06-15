/**
 * Permission flag construction for claude CLI spawns.
 * Single source of truth for the two permission flags across all arg-builder sites.
 */

const EMITTABLE_PERMISSION_MODES = new Set(['plan', 'acceptEdits']);

export function buildPermissionArgs({ permissionMode, skipPermissions } = {}) {
  // DECISION: per domain/rules.md → Permission Mode Rules, only flag-level modes reach this
  // function. plan_execute is dashboard-only chain state and must never arrive here — throw
  // loudly rather than silently coerce, so a chain-routing bug surfaces instead of bypassing.
  if (!EMITTABLE_PERMISSION_MODES.has(permissionMode)) {
    throw new Error(`buildPermissionArgs: unsupported permissionMode "${permissionMode}" (expected plan|acceptEdits)`);
  }
  const args = ['--permission-mode', permissionMode];
  // --dangerously-skip-permissions (≡ bypassPermissions) is never emitted in plan mode — it
  // would defeat plan mode (claude bug #17544: skip-perms silently overrides plan mode).
  if (permissionMode !== 'plan' && skipPermissions) {
    args.push('--dangerously-skip-permissions');
  }
  return args;
}
