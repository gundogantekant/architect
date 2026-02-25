# Use Case: Migrate Stack

Plan and execute technology migration.

## Input
- Source technology
- Target technology
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Migration plan (phased), then implementation per phase (if approved)

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: run scout to understand current state)

## Agent(s)
- **planner** (model: opus, read-only) — migration plan
- **coder** variants — implementation per phase
- **tester** (model: sonnet) — phase verification
- **reviewer** (model: opus, read-only) — migration quality

## Steps

1. Load portfolio context for current stack info
2. Planner creates migration plan:
   - Scope analysis, affected files, phased strategy, risks, breaking changes
3. Present plan for user approval:
   - Phase breakdown with dependencies
   - Risk assessment
   - Incremental vs big-bang recommendation
4. If approved, create a worktree via `usecases/manage-worktree.md` → create
5. Execute phase by phase in the worktree:
   - Coder agents implement each phase
   - Tester verifies each phase
   - Reviewer checks migration quality
6. Present results: offer `/pr` to merge or `/worktree cleanup` to discard

## Post-conditions
- Plan presented before any execution
- Project remains buildable at each phase
- Backward compatibility maintained during transition
