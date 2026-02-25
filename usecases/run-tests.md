# Use Case: Run Tests

Execute, generate, or report coverage for project tests.

## Input
- Scope: "run" (default), "generate", "coverage", or file paths
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Test results, coverage report, or generated test files

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: run scout to detect testing framework)

## Agent(s)
- **tester** (model: sonnet) — for test generation and execution
- **scout** (model: haiku) — fallback stack detection

## Steps

1. Load portfolio context to identify testing framework and conventions
2. Based on scope:
   - **run**: Execute test suite using detected test runner (no worktree needed)
   - **generate**: Create a worktree via `usecases/manage-worktree.md` → create, then tester agent analyzes code, checks existing test patterns, generates tests in the worktree, verifies they pass. Present results: offer `/pr` to merge or `/worktree cleanup` to discard
   - **coverage**: Run tests with coverage reporting enabled (no worktree needed)
   - **file paths**: Run/generate tests for specific files (worktree if generating, no worktree if running)
3. Report results

## Post-conditions
- Generated tests follow project conventions
- All generated tests pass before being presented
