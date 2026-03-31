---
name: refactor
description: Systematic refactoring with decomposition, execution, and verification
execution: dispatch
user_invocable: true
arguments:
  - name: scope
    description: Description of the refactoring to perform
    required: true
---

# /refactor

Plan and execute systematic code refactoring.

## Agents Dispatched
- **planner** (opus) — refactoring decomposition
- **refactorer** (sonnet) — transformation execution
- **tester** (sonnet) — verification
- **reviewer** (sonnet) — quality check

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout to detect the stack)

2. Follow `usecases/refactor-code.md` with scope from `$ARGUMENTS.scope`

## Output

- Refactoring plan with affected files
- Transformations applied
- Test verification results
- Review confirmation that behavior is preserved
