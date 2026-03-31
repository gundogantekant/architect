# Use Case: Triage Request

Two-stage request classification and dispatch planning using classifier (fast) + coordinator (detailed).

## Input
- User work request (free-form text)
- Portfolio context (if available, from `usecases/load-portfolio-context.md`)

## Output
- ClassifierOutput (see `domain/entities.md` → ClassifierOutput) for simple cases
- DispatchPlan (see `domain/entities.md` → DispatchPlan) for complex cases

## Preconditions
- Follow `usecases/load-portfolio-context.md` to load project context if a target project is identifiable

## Agent(s)
- **classifier** (model: haiku, read-only) — fast triage, always runs first
- **coordinator** (model: sonnet, read-only) — detailed planning, only when needed

## Steps

### Stage 1: Fast Classification

1. Orchestrator dispatches **classifier** (haiku) with the user request and minimal context
2. Classifier reads the request and outputs ClassifierOutput JSON:
   - Classifies request type using `domain/rules.md` → Complexity Heuristics
   - Suggests workflow using `domain/rules.md` → Workflow Selection
   - Suggests agent list using `domain/rules.md` → Agent Inclusion Rules
   - Sets `needs_coordinator: true` when complexity >= medium, confidence < 0.6, or parallelization planning is required

### Stage 2: Detailed Planning (conditional)

3. If `needs_coordinator` is **false**: orchestrator constructs a simple DispatchPlan directly from ClassifierOutput — no coordinator needed. The orchestrator maps suggested_agents to ordered steps and skips parallelization analysis for simple workflows.

4. If `needs_coordinator` is **true**: orchestrator dispatches **coordinator** (sonnet) with the ClassifierOutput + portfolio context (standard tier)
5. Coordinator resolves all five Target Project fields (see `domain/rules.md` → Target Project Identification)
6. Coordinator validates and potentially adjusts the classifier's assessment
7. Coordinator checks `domain/rules.md` → Clarification Triggers
8. Coordinator builds ordered dispatch plan with `parallel_with` per `domain/rules.md` → Parallelization Rules
9. Coordinator outputs a DispatchPlan JSON (see `domain/entities.md` → DispatchPlan)
10. Coordinator sets `worktree_required: true` when any step uses an Implementation agent
11. If complexity is medium+, coordinator includes `suggested_work_item` in output

## Post-conditions
- Main conversation follows the execution plan steps
- Clarifications are resolved before dispatching agents
- If `suggested_work_item` is present, orchestrator offers to create it via `/work add`
