# Use Case: Synthesize Findings

Translate unstructured investigation findings into an executable DispatchPlan.

## Input

- `goal` — user-facing success condition (string)
- `findings` — markdown output from any investigation agent (scout, debugger, security-auditor, profiler, reviewer)
- `target_project` — all five fields, resolved by the orchestrator before invoking this use case:
  - `organization`, `project`, `component`, `path`, `branch`

## Output

- DispatchPlan JSON (from findings-coordinator) with `source_agent: "findings-coordinator"`

## Preconditions

- The orchestrator has already resolved all five target_project fields (see `domain/rules.md` → Target Project Identification)
- An investigation agent has completed and produced findings — this use case is not for fresh user requests

## Agent(s)

- **findings-coordinator** (model: sonnet, read-only) — infers complexity, selects workflow, builds DispatchPlan from findings

## Steps

1. **Orchestrator resolves target_project** — all five fields must be populated before dispatching findings-coordinator. This step runs in the orchestrator, not the agent.

2. **Orchestrator constructs the prompt** with three sections:
   - `## Goal` — the user-stated or inferred success condition
   - `## Findings` — verbatim or summarized output from the investigation agent
   - `## Context` — the resolved target_project JSON

3. **Dispatch findings-coordinator** (sonnet, read-only).

4. **Validate output**:
   - If the response is an error object (`{ "error": "target_project required", ... }`): fix the missing fields and re-dispatch.
   - If complexity is medium+: confirm `execution_plan.steps` includes a plan-gate step and a code-gate step. If either is missing, reject and re-dispatch with explicit instruction: "You must include plan-gate and code-gate steps for medium+ complexity."
   - For each step in `execution_plan.steps` that uses an implementation agent (coder-*, coder, coder-backend, coder-frontend, etc.): verify the step carries a complete contract with all 4 core fields (`goal`, `constraints`, `expected_output`, `failure_conditions`) and a non-empty `e2e_test_criteria` array (≥1 entry for medium, ≥3 for large complexity). If any implementation step has an incomplete contract, reject and re-dispatch with the specific missing fields listed.
   - If `clarifications_needed` is non-empty and no steps are present: surface clarifications to the user before proceeding.

5. **Orchestrator executes the returned DispatchPlan** following the step order and `parallel_with` groups.

## When to Use This vs. Triage Request

| Condition | Workflow |
|-----------|----------|
| Fresh user request — no prior investigation | `usecases/triage-request.md` (classifier → coordinator) |
| Investigation agent has completed; findings are the primary input | `usecases/synthesize-findings.md` (findings-coordinator) |

Use triage-request when a ClassifierOutput is the signal. Use synthesize-findings when unstructured findings from an investigation agent are the signal.
