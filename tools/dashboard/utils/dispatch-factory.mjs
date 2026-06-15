import { MissingDispatchFieldError } from './errors.mjs';

export const REQUIRED_DISPATCH_FIELDS = ['id', 'projectKey', 'projectPath'];

function _buildBaseDispatch(params) {
  for (const f of REQUIRED_DISPATCH_FIELDS) {
    if (!params[f]) throw new MissingDispatchFieldError(f);
  }
  return {
    id: params.id,
    work_item_id: params.workItemId ?? null,
    epic_id: params.epicId ?? null,
    project_key: params.projectKey,
    project_path: params.projectPath,
    title: params.title ?? null,
    model: params.model ?? null,
    permission_mode: params.permissionMode ?? 'acceptEdits',
    skip_permissions: params.skipPermissions ?? false,
    dispatch_mode: params.dispatchMode ?? 'standard',
    skill_id: params.skillId ?? null,
    status: 'running',
    agent_phase: 'generating',
    agent_phase_history: [],
    contract: params.contract ?? null,
    claude_session_id: params.claudeSessionId ?? null,
    worktree_path: params.worktreePath ?? null,
    worktree_branch: params.worktreeBranch ?? null,
    source_branch: params.sourceBranch ?? null,
    chain_mode: params.chainMode ?? null,
    chain_phase: params.chainPhase ?? null,
    chain_autostart: params.chainAutostart ?? null,
    chain_parent_id: params.chainParentId ?? null,
    scope_violation: null,
    session_log: [],
    output: [],
    lastLines: [],
    wsClients: new Set(),
    started_at: new Date().toISOString(),
    completed_at: null,
  };
}

export function createDispatch(params) {
  return _buildBaseDispatch(params);
}

export function createResumeDispatch(params) {
  if (!params.claudeSessionId) throw new MissingDispatchFieldError('claudeSessionId');
  return {
    ..._buildBaseDispatch({ ...params, dispatchMode: params.dispatchMode ?? 'resume' }),
    _autoExtended: params.autoExtended ?? false,
  };
}
