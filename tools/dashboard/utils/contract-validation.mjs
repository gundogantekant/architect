// Single source of truth for contract validation thresholds.
// Thresholds mirror domain/rules.md → Dispatch Contract Rules table.
// A parity test in tests/contract-validation.spec.mjs keeps this in sync.

import { isLarge, isSmallOrAbove, getComplexityLevel } from './complexity.mjs';

export const CONTRACT_THRESHOLDS = {
  small: { e2eMin: 1, requiresSuccess: true, requiresCoreFields: true },
  medium: { e2eMin: 1, requiresSuccess: true, requiresCoreFields: true },
  large: { e2eMin: 3, requiresScopeBoundary: true, stopConditionsMin: 3 },
};

export function validateContract(workItem, contract) {
  const complexity = getComplexityLevel(workItem);
  if (!isSmallOrAbove(complexity)) return null;

  const violations = [];
  const core = ['goal', 'constraints', 'expected_output', 'failure_conditions'];

  if (complexity === 'small') {
    for (const field of core) {
      if (!contract?.[field]?.trim()) {
        violations.push({ field, message: `required for small+ complexity` });
      }
    }
    if (!contract?.success_criteria?.trim()) {
      violations.push({ field: 'success_criteria', message: 'required for small+ complexity' });
    }
    const smallCriteria = contract?.e2e_test_criteria;
    if (!smallCriteria || smallCriteria.length < CONTRACT_THRESHOLDS.small.e2eMin) {
      violations.push({
        field: 'e2e_test_criteria',
        message: `must have >= ${CONTRACT_THRESHOLDS.small.e2eMin} entries for small complexity`,
      });
    }
    return violations.length > 0 ? violations : null;
  }

  for (const field of core) {
    if (!contract?.[field]?.trim()) {
      violations.push({ field, message: `required for medium+ complexity` });
    }
  }

  if (!contract?.success_criteria?.trim()) {
    violations.push({ field: 'success_criteria', message: 'required for medium+ complexity' });
  }

  const criteria = contract?.e2e_test_criteria;
  const minE2e = isLarge(workItem) ? CONTRACT_THRESHOLDS.large.e2eMin : CONTRACT_THRESHOLDS.medium.e2eMin;
  const complexityLabel = isLarge(workItem) ? 'large' : 'medium';
  if (!criteria || criteria.length < minE2e) {
    violations.push({
      field: 'e2e_test_criteria',
      message: `must have >= ${minE2e} entries for ${complexityLabel} complexity`,
    });
  }

  if (isLarge(workItem)) {
    if (!contract?.scope_boundary?.trim()) {
      violations.push({ field: 'scope_boundary', message: 'required for large complexity' });
    }
    const stops = contract?.stop_conditions;
    if (!stops || stops.length < CONTRACT_THRESHOLDS.large.stopConditionsMin) {
      violations.push({
        field: 'stop_conditions',
        message: `must have >= ${CONTRACT_THRESHOLDS.large.stopConditionsMin} entries for large complexity`,
      });
    }
  }

  return violations.length > 0 ? violations : null;
}
