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
2. Create a worktree via `usecases/manage-worktree.md` → create (planner reads main tree; refactorer and tester work in worktree)
3. Dispatch planner with `target_project: org/project/component` (or absolute path) in the prompt. Planner analyzes the refactoring scope:
   - Identify all affected files
   - Decompose into atomic transformation steps
   - Order steps to minimize intermediate breakage
   - Flag risks and dependencies between steps
4. Present refactoring plan for user approval
5. If approved, execute step by step in the worktree:
   - Refactorer applies each transformation
   - After each major step: verify the project still builds
6. Tester runs existing test suite in the worktree to verify behavior preservation
7. If tests fail: investigate and fix before proceeding (see `domain/rules.md` → Error Recovery)
8. Reviewer checks that refactoring is clean and behavior-preserving
9. Present results: summarize changes, offer `/pr` to merge or `/worktree cleanup` to discard

## Post-conditions
- All transformations preserve existing behavior
- Tests pass after refactoring
- No features added or bugs fixed during refactoring (report separately)
