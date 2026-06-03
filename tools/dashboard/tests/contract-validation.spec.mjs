import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateContract, CONTRACT_THRESHOLDS } from '../utils/contract-validation.mjs';

// Parity test: these thresholds must match domain/rules.md → Dispatch Contract Rules table
describe('CONTRACT_THRESHOLDS parity with domain/rules.md', () => {
  it('small complexity requires e2e_test_criteria >= 1', () => {
    assert.equal(CONTRACT_THRESHOLDS.small.e2eMin, 1);
  });
  it('small complexity requires success_criteria', () => {
    assert.equal(CONTRACT_THRESHOLDS.small.requiresSuccess, true);
  });
  it('small complexity requires core fields', () => {
    assert.equal(CONTRACT_THRESHOLDS.small.requiresCoreFields, true);
  });
  it('medium complexity requires e2e_test_criteria >= 1', () => {
    assert.equal(CONTRACT_THRESHOLDS.medium.e2eMin, 1);
  });
  it('large complexity requires e2e_test_criteria >= 3', () => {
    assert.equal(CONTRACT_THRESHOLDS.large.e2eMin, 3);
  });
  it('large complexity requires scope_boundary', () => {
    assert.equal(CONTRACT_THRESHOLDS.large.requiresScopeBoundary, true);
  });
  it('large complexity requires stop_conditions >= 3', () => {
    assert.equal(CONTRACT_THRESHOLDS.large.stopConditionsMin, 3);
  });
});

describe('validateContract', () => {
  const baseContract = {
    goal: 'do the thing',
    constraints: 'no bad things',
    expected_output: 'result',
    failure_conditions: 'nothing works',
  };

  it('returns null for trivial complexity', () => {
    const item = { priority: 'low', tags: ['trivial'] };
    assert.equal(validateContract(item, {}), null);
  });

  it('T1 Fast Path regression: trivial item with no contract fields returns null', () => {
    const item = { tags: ['trivial', 'T1'] };
    assert.equal(validateContract(item, null), null);
  });

  it('returns violations for small with missing e2e_test_criteria', () => {
    const item = { tags: ['small'] };
    const violations = validateContract(item, { ...baseContract, success_criteria: 'done when X' });
    assert.ok(violations?.some(v => v.field === 'e2e_test_criteria'));
  });

  it('returns violations for small with missing success_criteria', () => {
    const item = { tags: ['small'] };
    const violations = validateContract(item, { ...baseContract, e2e_test_criteria: ['test A'] });
    assert.ok(violations?.some(v => v.field === 'success_criteria'));
  });

  it('passes small with all required fields', () => {
    const item = { tags: ['small'] };
    const result = validateContract(item, {
      ...baseContract,
      success_criteria: 'user can see result',
      e2e_test_criteria: ['load page and verify result'],
    });
    assert.equal(result, null);
  });

  it('returns violations for medium with missing e2e_test_criteria', () => {
    const item = { tags: ['medium'] };
    const violations = validateContract(item, { ...baseContract, success_criteria: 'done' });
    assert.ok(violations?.some(v => v.field === 'e2e_test_criteria'));
  });

  it('returns violations for medium with missing success_criteria', () => {
    const item = { tags: ['medium'] };
    const violations = validateContract(item, { ...baseContract, e2e_test_criteria: ['test A'] });
    assert.ok(violations?.some(v => v.field === 'success_criteria'));
  });

  it('passes medium with 1 e2e criterion and success_criteria', () => {
    const item = { tags: ['medium'] };
    const result = validateContract(item, { ...baseContract, e2e_test_criteria: ['test A'], success_criteria: 'user sees result' });
    assert.equal(result, null);
  });

  it('fails large with 2 e2e criteria', () => {
    const item = { tags: ['large'] };
    const violations = validateContract(item, { ...baseContract, e2e_test_criteria: ['a', 'b'], scope_boundary: 'tools/', stop_conditions: ['s1', 's2', 's3'], success_criteria: 'done' });
    assert.ok(violations?.some(v => v.field === 'e2e_test_criteria'));
  });

  it('passes large with 3 e2e criteria + scope_boundary + stop_conditions + success_criteria', () => {
    const item = { tags: ['large'] };
    const result = validateContract(item, {
      ...baseContract,
      e2e_test_criteria: ['a', 'b', 'c'],
      scope_boundary: 'tools/dashboard',
      stop_conditions: ['s1', 's2', 's3'],
      success_criteria: 'all tests pass',
    });
    assert.equal(result, null);
  });

  it('fails large without scope_boundary', () => {
    const item = { tags: ['large'] };
    const violations = validateContract(item, { ...baseContract, e2e_test_criteria: ['a', 'b', 'c'], stop_conditions: ['s1', 's2', 's3'], success_criteria: 'done' });
    assert.ok(violations?.some(v => v.field === 'scope_boundary'));
  });

  it('fails large with fewer than 3 stop_conditions', () => {
    const item = { tags: ['large'] };
    const violations = validateContract(item, { ...baseContract, e2e_test_criteria: ['a', 'b', 'c'], scope_boundary: 'tools/', stop_conditions: ['s1', 's2'], success_criteria: 'done' });
    assert.ok(violations?.some(v => v.field === 'stop_conditions'));
  });
});
