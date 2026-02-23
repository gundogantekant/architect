---
name: test
description: Run existing tests, generate missing tests, and report coverage
user_invocable: true
arguments:
  - name: scope
    description: "'run' to execute tests, 'generate' to create missing tests, 'coverage' for coverage report, or file paths"
    required: false
---

# /test

Run and generate tests for the project.

## Agents Dispatched
- **tester** (sonnet) — test generation and execution
- **scout** (haiku) — fallback stack detection

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: run scout to detect the testing framework)

2. Follow `usecases/run-tests.md` with scope from `$ARGUMENTS.scope`

## Output

- Test execution results (pass/fail counts)
- Coverage report (if requested)
- Generated test files (if generating)
- Recommendations for improving test coverage
