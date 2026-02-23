# Use Case: Refactor Code

Systematic code refactoring with planning, execution, and verification.

## Input
- Refactoring scope description
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Refactoring plan, executed transformations, verification results

## Preconditions
- Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout)

## Agent(s)
- **planner** (opus) — decompose refactoring into atomic steps
- **refactorer** (sonnet) — execute transformations
- **tester** (sonnet) — verify behavior preservation
- **reviewer** (sonnet) — quality check

## Steps

1. Load portfolio context for project structure and conventions
2. Planner analyzes the refactoring scope:
   - Identify all affected files
   - Decompose into atomic transformation steps
   - Order steps to minimize intermediate breakage
   - Flag risks and dependencies between steps
3. Present refactoring plan for user approval
4. If approved, execute step by step:
   - Refactorer applies each transformation
   - After each major step: verify the project still builds
5. Tester runs existing test suite to verify behavior preservation
6. If tests fail: investigate and fix before proceeding (see `domain/rules.md` → Error Recovery)
7. Reviewer checks that refactoring is clean and behavior-preserving

## Post-conditions
- All transformations preserve existing behavior
- Tests pass after refactoring
- No features added or bugs fixed during refactoring (report separately)
