# Use Case: Triage Request

PM-driven request classification and dispatch planning.

## Input
- User work request (free-form text)
- Portfolio context (if available, from `usecases/load-portfolio-context.md`)

## Output
- DispatchPlan (see `domain/entities.md` → DispatchPlan)

## Preconditions
- Follow `usecases/load-portfolio-context.md` to load project context if a target project is identifiable

## Agent(s)
- **pm** (model: sonnet, read-only)

## Steps

1. PM reads the user request
2. PM loads portfolio context (or flags its absence)
3. PM classifies the request using `domain/rules.md` → Complexity Heuristics
4. PM checks `domain/rules.md` → Clarification Triggers
5. PM selects workflow using `domain/rules.md` → Workflow Selection
6. PM determines agent sequence using `domain/rules.md` → Agent Inclusion Rules
7. PM outputs a DispatchPlan JSON (see `domain/entities.md` → DispatchPlan)
8. PM sets `worktree_required: true` in the execution plan when any step uses an Implementation agent (see `domain/entities.md` → DispatchPlan)
9. If complexity is medium+, PM includes `suggested_work_item` in output

## Post-conditions
- Main conversation follows the execution plan steps
- Clarifications are resolved before dispatching agents
- If `suggested_work_item` is present, orchestrator offers to create it via `/work add`
