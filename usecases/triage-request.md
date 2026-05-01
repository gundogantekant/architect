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

### Stage 1a: Pre-Dispatch Check (conditional)

The orchestrator evaluates whether a pre-dispatch check is warranted based on the classifier's output (see `domain/rules.md` → Pre-Dispatch Check Rules).

3. If `classification.type` is in {feature, bugfix, refactor, maintenance} AND `classification.complexity` >= small:
   a. Extract 2–5 keywords from the user's request (entity names, action verbs, file/module names)
   b. Run `git log --oneline -20 --grep=<term> -i` for each keyword on the target project
   c. Query `GET /api/work-items/search?q=<terms>&project_key=<key>` to find all non-terminal items matching keywords; also check any `done` items in results for the Already Done check
   d. Query `GET /api/dispatch/active` and filter by work item title match
   e. If request mentions specific files: `git log --oneline -5 -- <path>`
   f. Score matches into a `PreDispatchCheckResult` (see `domain/entities.md`)
   g. If `status` is `warning` or `conflict`: present findings to user, wait for confirmation
   h. If user confirms or status is `clear`: proceed to Stage 2

4. If the check is skipped (trivial complexity, non-work type, not in portfolio, or explicit work item reference): proceed directly to Stage 2.

**Parallelization**: When both the pre-dispatch check and the coordinator are needed, dispatch them in parallel. They are independent — the coordinator does not need the check result, and the check does not need the coordinator's dispatch plan.

### Stage 2: Detailed Planning (conditional)

5. If `needs_coordinator` is **false**: orchestrator constructs a simple DispatchPlan directly from ClassifierOutput — no coordinator needed. The orchestrator maps suggested_agents to ordered steps and skips parallelization analysis for simple workflows.

6. If `needs_coordinator` is **true**: orchestrator dispatches **coordinator** (sonnet) with the ClassifierOutput + portfolio context (standard tier)
7. Coordinator resolves all five Target Project fields (see `domain/rules.md` → Target Project Identification)
8. Coordinator validates and potentially adjusts the classifier's assessment
9. Coordinator checks `domain/rules.md` → Clarification Triggers
10. Coordinator builds ordered dispatch plan with `parallel_with` per `domain/rules.md` → Parallelization Rules
11. Coordinator outputs a DispatchPlan JSON (see `domain/entities.md` → DispatchPlan)
12. Coordinator sets `worktree_required: true` when any step uses an Implementation agent
13. If complexity is medium+, coordinator includes `suggested_work_item` in output

## Post-conditions
- Main conversation follows the execution plan steps
- Pre-dispatch check findings (if any) are resolved before dispatching agents
- Clarifications are resolved before dispatching agents
- If `suggested_work_item` is present, orchestrator offers to create it via `/work add`
