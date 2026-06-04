import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDispatch, createResumeDispatch, REQUIRED_DISPATCH_FIELDS } from '../utils/dispatch-factory.mjs';
import { MissingDispatchFieldError } from '../utils/errors.mjs';

const BASE_PARAMS = {
  id: 'D-test-1',
  projectKey: 'ticari/architect/main',
  projectPath: '/tmp/test-project',
};

describe('REQUIRED_DISPATCH_FIELDS', () => {
  it('matches the fields the factory actually validates', () => {
    assert.deepEqual(REQUIRED_DISPATCH_FIELDS, ['id', 'projectKey', 'projectPath']);
  });
});

describe('createDispatch', () => {
  it('returns the correct shape with all required and default fields set', () => {
    const d = createDispatch(BASE_PARAMS);
    assert.equal(d.id, 'D-test-1');
    assert.equal(d.project_key, 'ticari/architect/main');
    assert.equal(d.project_path, '/tmp/test-project');
    assert.equal(d.status, 'running');
    assert.equal(d.agent_phase, 'generating');
    assert.deepEqual(d.agent_phase_history, []);
    assert.deepEqual(d.output, []);
    assert.deepEqual(d.lastLines, []);
    assert.ok(d.wsClients instanceof Set);
    assert.ok(typeof d.started_at === 'string');
    assert.equal(d.completed_at, null);
    assert.equal(d.scope_violation, null);
    assert.deepEqual(d.session_log, []);
  });

  it('throws MissingDispatchFieldError when id is missing', () => {
    assert.throws(
      () => createDispatch({ projectKey: 'k', projectPath: '/p' }),
      (e) => e instanceof MissingDispatchFieldError && e.field === 'id'
    );
  });

  it('throws MissingDispatchFieldError when projectKey is missing', () => {
    assert.throws(
      () => createDispatch({ id: 'D-1', projectPath: '/p' }),
      (e) => e instanceof MissingDispatchFieldError && e.field === 'projectKey'
    );
  });

  it('throws MissingDispatchFieldError when projectPath is missing', () => {
    assert.throws(
      () => createDispatch({ id: 'D-1', projectKey: 'k' }),
      (e) => e instanceof MissingDispatchFieldError && e.field === 'projectPath'
    );
  });

  it('optional fields default to null (work_item_id, epic_id, skill_id)', () => {
    const d = createDispatch(BASE_PARAMS);
    assert.equal(d.work_item_id, null);
    assert.equal(d.epic_id, null);
    assert.equal(d.skill_id, null);
  });

  it('scope_violation defaults to null (not-yet-checked sentinel)', () => {
    const d = createDispatch(BASE_PARAMS);
    assert.equal(d.scope_violation, null);
  });

  it('status defaults to "running" and agent_phase defaults to "generating"', () => {
    const d = createDispatch(BASE_PARAMS);
    assert.equal(d.status, 'running');
    assert.equal(d.agent_phase, 'generating');
  });
});

describe('createResumeDispatch', () => {
  it('sets claude_session_id and _autoExtended correctly', () => {
    const d = createResumeDispatch({
      ...BASE_PARAMS,
      claudeSessionId: 'sess-abc123',
      autoExtended: true,
    });
    assert.equal(d.claude_session_id, 'sess-abc123');
    assert.equal(d._autoExtended, true);
  });

  it('_autoExtended defaults to false when not provided', () => {
    const d = createResumeDispatch({
      ...BASE_PARAMS,
      claudeSessionId: 'sess-abc123',
    });
    assert.equal(d._autoExtended, false);
  });

  it('throws MissingDispatchFieldError when claudeSessionId is missing', () => {
    assert.throws(
      () => createResumeDispatch(BASE_PARAMS),
      (e) => e instanceof MissingDispatchFieldError && e.field === 'claudeSessionId'
    );
  });

  it('sets dispatch_mode to "resume" by default', () => {
    const d = createResumeDispatch({
      ...BASE_PARAMS,
      claudeSessionId: 'sess-abc123',
    });
    assert.equal(d.dispatch_mode, 'resume');
  });
});
