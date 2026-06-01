export class ContractIncompleteError extends Error {
  constructor(violations) {
    super('Contract derived from description is incomplete');
    this.name = 'ContractIncompleteError';
    this.violations = violations;
  }
}
