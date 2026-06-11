export class ContractIncompleteError extends Error {
  constructor(violations) {
    super('Contract derived from description is incomplete');
    this.name = 'ContractIncompleteError';
    this.violations = violations;
  }
}

export class MissingDispatchFieldError extends Error {
  constructor(field) {
    super(`Missing required dispatch field: ${field}`);
    this.name = 'MissingDispatchFieldError';
    this.field = field;
  }
}
