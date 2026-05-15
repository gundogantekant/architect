# Implementation Session

## Session Mode

Implementation. Permitted: code changes via dispatched agents, git operations (worktree creation/deletion, commits, merges), ticket management (status transitions, logging, flag updates), test execution, review board dispatches, artifact writes, follow-up draft ticket creation.

Prohibited: touching any protected branch directly; committing without a Code Gate pass; merging a worktree branch with unresolved `block` verdicts; implementing any ticket with `status ≠ planned`; creating new work items without a concrete rationale from implementation discovery.

---

## Depth Constraint

This session runs **at depth 0 only** — it is the orchestrator, not a dispatched sub-agent. If this prompt is executed by an agent with `X-Architect-Session-Depth >= 1` in its environment (i.e., it was spawned via the dashboard's standard `POST /api/dispatch` path), halt immediately: "Implementation Session must run at depth 0. Re-dispatch from the CLI or via the terminal path." Do not proceed.

---

## Goal

Implement all eligible work items for the target project. Items are processed in dependency-ordered batches; independent items within each batch are dispatched concurrently in isolated worktrees. Each ticket follows the full `usecases/implement-work-item.md` pipeline: Plan Gate (if not already passed and still valid), worktree, coder → tester → Code Gate → commit → merge-back.

Items that cannot proceed are marked `input_needed` with a specific reason and skipped; the session continues on all remaining eligible items. Follow-up work discovered during implementation is captured as new `draft` tickets; the user controls when they are refined and implemented.

The session writes planning metadata to `work/impl-sessions/<session-id>.json`. Work item status transitions flow exclusively through the dashboard API — the session file is coordination metadata, not a mutable truth store.

---

## Auto-Implement Mode

When dispatched via the dashboard with "Skip permissions" enabled, proceed through all steps without pausing for user confirmation.

**Non-bypassable pauses** — these require user input even in Auto-Implement Mode:
- A Review Board gate returns `block` after 2 revision cycles on the same ticket.
- The Roadmap Review Board returns `block` after 1 revision cycle — halt the entire session and surface all block concerns to the user before proceeding.
- A merge-back fails (conflict unresolvable by coder after 2 attempts).
- ≥50% of tickets in a single batch halt with `input_needed` (likely a systemic issue — surface grouped questions and wait before starting the next batch).
- Merge branch verification fails (merge commit not reachable from expected originating branch HEAD).

For all other single-ticket blockers: mark `input_needed` and continue the session.

---

## Eligibility Criteria

A ticket is eligible for dispatch if ALL hold:

1. `status = planned`
2. `input_needed = false` (or field absent)
3. `approval_active = false` (or field absent)
4. All items in `depends_on` have `status = done`
5. DispatchContract is present with at minimum: `goal`, `constraints`, `expected_output`, `failure_conditions`

Tickets failing criterion 4 but whose blocking prerequisites are `eligible` in this session are queued as "blocked pending batch completion" — they become eligible automatically when their prerequisites merge successfully within the session.

Tickets with `status = in-progress`, `in-review`, or `testing` are evaluated for contract completeness only (no re-dispatch). Surface any gaps in the final summary.

---

## Named Protocol: `input_needed` Halt

Apply this protocol at any sub-step (6a–6f) when a decision cannot be resolved from context, portfolio knowledge, or the work item:

1. `PATCH /api/work-items/:id` with `{"input_needed": true, "input_needed_reason": "<specific question — 1–2 sentences>", "input_needed_from": "user"}`
2. `POST /api/work-items/:id/log` with `{"summary": "Halted at <step>: input needed — <question>"}`
3. Update session file ticket entry: `stage: "input_needed"`, `halted_at_step: "<6a|6b|6c|6d|6e|6f>"`, `halted_reason: "<same question text>"`, `worktree_preserved: <true|false>`.
4. Continue to the next ticket — do not halt the session.

On re-dispatch (user provides answer via "Additional Instructions"): read `session_log` for the halt reason, read `additional_instructions` for the answer, clear the flag (`PATCH` with `{"input_needed": false}`), resume from the halted step.

---

## Step 1 — Initialize Session File

Generate session ID: `impl-<YYYY-MM-DD-HH-mm>-<org>-<proj>-<comp>`

Create `work/impl-sessions/<session-id>.json`:

```json
{
  "session_id": "<session-id>",
  "started_at": "<ISO8601>",
  "project": { "org": "<org>", "project": "<project>", "component": "<component>" },
  "status": "in_progress",
  "batches": [],
  "checkpoints": [],
  "tickets": {},
  "summary": {
    "eligible": 0,
    "dispatched": 0,
    "merged": 0,
    "input_needed": 0,
    "skipped_dependency": 0,
    "follow_up_created": 0
  }
}
```

Per-ticket entry schema (populated in Step 3, updated after every stage change):

```json
{
  "W-XXX": {
    "title": "...",
    "complexity": null,
    "priority": null,
    "estimate_hours": null,
    "batch_index": null,
    "stage": "pending",
    "worktree_path": null,
    "originating_branch": null,
    "branch": null,
    "plan_gate_status": null,
    "plan_gate_artifact": null,
    "test_report_artifact": null,
    "code_gate_status": null,
    "commit_sha": null,
    "merged": false,
    "merge_verified": false,
    "halted_at_step": null,
    "halted_reason": null,
    "worktree_preserved": false,
    "follow_up_tickets": [],
    "updated_at": "<ISO8601>"
  }
}
```

Write checkpoints after every significant event:

```json
{ "at": "<ISO8601>", "event": "<batch_start|item_start|plan_gate_done|worktree_created|impl_done|test_report_written|tests_done|code_gate_done|commit_done|merge_done|item_halted|roadmap_approved>", "id": "W-XXX", "batch": 0 }
```

Write the session file before any other action. The dashboard DB is authoritative for work item status — the session file records planning metadata and checkpoint history for resumability only.

---

## Step 2 — Load Portfolio Context

1. Resolve target project from `$ARCHITECT_PORTFOLIO_DIR/registry.json`. If ambiguous, ask before proceeding.
2. Load portfolio context at **standard** tier: `$ARCHITECT_PORTFOLIO_DIR/<org>/<project>/<component>.json`
3. Load org conventions: `$ARCHITECT_PORTFOLIO_DIR/<org>/organization.json`
4. Load sync context: `GET /api/sync/significant?project_key=<key>` for recent architectural commits.
5. Fetch active epics: `GET /api/epics` filtered to project — used to surface epic-level blockers.

The originating branch for each worktree is captured per-ticket at worktree creation time (step 6b) via `manage-worktree.md` — not as a single session-level variable. This allows different tickets to target different branches per their portfolio entries.

---

## Step 3 — Fetch and Classify Eligible Tickets

1. `GET /api/backlog` filtered to target project. In parallel, fetch for each item:
   - Full item: `GET /api/work-items/:id`
   - Artifacts list: `GET /api/work-items/:id/artifacts`
   - Plan: `GET /api/work-items/:id/plan`

2. Apply eligibility criteria and classify each ticket:

| Classification        | Condition |
|-----------------------|-----------|
| `eligible`            | All eligibility criteria satisfied |
| `blocked_dependency`  | `depends_on` has items not yet `done` |
| `input_needed`        | `input_needed = true` |
| `approval_pending`    | `approval_active = true` |
| `contract_gap`        | Status ≥ planned but DispatchContract missing or incomplete |
| `in_flight`           | Status = `in-progress`, `in-review`, or `testing` |
| `terminal`            | Status = `done`, `cancelled`, `archived` |

3. Determine Plan Gate status for each `eligible` ticket:
   - If a `board-review-*.md` artifact exists **and** its `created_at` is later than the work item's `updated_at` → Plan Gate valid; skip re-run.
   - If the artifact exists but its timestamp predates `updated_at` → stale; Plan Gate must re-run.
   - If no artifact exists → Plan Gate must run (step 6a).

4. Populate all `eligible` tickets in the session file.

---

## Step 4 — Dependency Graph and Batch Planning

1. Build directed dependency graph from `depends_on` arrays of all `eligible` tickets.
2. Detect cycles with DFS. For cyclic tickets: apply `input_needed` halt protocol with reason "cyclic dependency detected". Do not process them.
3. Compute topological order (Kahn's algorithm — roots first).
4. Within each topological layer, evaluate independence. Tickets are independent when ALL hold:
   - No shared scope boundary (different modules or layers)
   - No data dependency between their contracts
   - No shared DB table or API endpoint schema being modified
   - No ordering constraint between their artifacts
   - No `scope_boundary` overlap detectable from DispatchContract fields (best-effort pre-check; overlap discovered at runtime triggers the `/pr` conflict path in 6f)
5. Group topological layers into named batches. Record in session file `batches`:
   ```json
   { "batch_index": 0, "parallel": true, "items": ["W-XXX", "W-YYY"] }
   ```
6. Assign complexity-based estimates per ticket:

| Complexity | Estimate  |
|------------|-----------|
| trivial    | ~1h       |
| small      | ~2–4h     |
| medium     | ~1–2 days |
| large      | ~3–5 days |

Derive complexity from the DispatchContract or work item description if not yet classified.

---

## Step 5 — Roadmap and Estimation

Present (or write to session file in Auto-Implement Mode before proceeding):

```
## Implementation Roadmap — <session-id>

### Batch Schedule
Batch 0 [parallel — N tickets]:
  W-XXX  "Title"  | medium  | ~1 day   | Plan Gate: valid (artifact up to date)
  W-YYY  "Title"  | small   | ~3h      | Plan Gate: needs run
  W-ZZZ  "Title"  | trivial | ~1h      | Plan Gate: valid

Batch 1 [sequential — depends on Batch 0 completing]:
  W-AAA  "Title"  | small   | ~2h      | Plan Gate: needs run
  → blocks resolved when: W-XXX, W-YYY done

### Pre-existing Blocks (not in scope this session)
  W-BBB  — input_needed already set: "<reason>"
  W-CCC  — contract_gap: DispatchContract missing expected_output
  W-DDD  — blocked_dependency: W-EEE not done (W-EEE not in this session)

### Estimates
  Session total (optimistic — full batch parallelism):  ~Xh
  Session total (pessimistic — sequential fallback):     ~Yh
  Tickets with pre-set input_needed (not in scope):      N

### Known Risks
  [Architectural conflicts, external dependencies, tickets near scope boundary overlap]
```

After presenting (or writing) the roadmap, dispatch a **Roadmap Review Board** on the roadmap artifact (`artifact_type=plan`). Board composition: **tech-reviewer-pm + tech-reviewer-arch**. Pass the full roadmap (batch schedule, estimates, dependency ordering, known risks) and the session's target project portfolio context at standard tier.

Reviewers evaluate: batch ordering correctness, dependency coverage, risk identification, complexity estimate plausibility. They do NOT evaluate individual ticket contracts — that is the Plan Gate's role (step 6a).

Verdict handling:
- All `approve` → write `roadmap_approved` checkpoint. Proceed to Step 6 immediately under skip-permissions semantics — no per-ticket user confirmation gates for the remainder of the session.
- Any `revise` (no `block`) → address concerns (re-order batches, adjust risks or estimates per board feedback), re-present the updated roadmap, re-run the board (max 1 revision cycle). On second approval → proceed.
- Any `block` after 1 revision cycle → **non-bypassable halt** (see Auto-Implement Mode above). Write session file `status: "halted_roadmap"`. Surface all block concerns to the user and await instruction before proceeding to Step 6.

---

## Step 6 — Execute Implementation Batches

Process batches **sequentially** — Batch N+1 starts only after all Batch N tickets are fully resolved (merged, `input_needed`, or follow-up created). After each batch, re-evaluate `blocked_dependency` tickets: any whose `depends_on` items all succeeded in this session moves into the next batch. Any whose dependency failed stays deferred for the rest of the session.

Within each batch, dispatch all independent ticket pipelines **concurrently** — one Agent call per ticket, all fired in the same message.

Write a `batch_start` checkpoint before dispatching each batch. Write an `item_start` checkpoint when each ticket's pipeline begins.

---

### 6a — Plan Gate (skip only if artifact is present and up to date — see Step 3)

Context tier for all tech-reviewer-* agents: **standard**.

Dispatch the Review Board (Plan Gate composition per `domain/rules.md` → Review Board Rules) with: work item title, description, DispatchContract, plan.md (if any), portfolio context at standard tier, epic context if linked.

Board composition:
- Always (standard tier): tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm
- Conditionally (standard tier):
  - tech-reviewer-frontend: scope touches UI or component code
  - tech-reviewer-ux: item introduces or changes user flows
  - tech-reviewer-dx: item changes developer-facing API, SDK, or CLI
  - tech-reviewer-dba: item touches DB schema or queries
  - tech-reviewer-systems: item crosses subsystem boundaries
  - tech-reviewer-prod: item introduces backend services, secrets, or runbooks

Verdict handling:
- All `approve` → `plan_gate_status: "passed"`. Write artifact. Record `plan_gate_artifact` in session file. Write `plan_gate_done` checkpoint. Proceed to 6b.
- Any `revise` (no `block`) → dispatch planner to address concerns; re-run board (max 2 cycles). Proceed after cleared.
- Any `block` after 2 cycles → apply `input_needed` halt protocol. `plan_gate_status: "failed"`. `halted_at_step: "6a"`.

Write artifact: `PUT /api/work-items/:id/artifacts/board-review-<session-id>.md` with all verdicts, concerns, and cycle counts.

---

### 6b — Worktree Creation

Dispatch git-ops to create a worktree per `usecases/manage-worktree.md`:
- Branch name: `W-<id>`
- Directory: sibling of project root at `<project-root>/../W-<id>`
- Base branch: managed by `manage-worktree.md` — it captures `originating_branch` via `git rev-parse --abbrev-ref HEAD` at creation time

If worktree creation fails (e.g., branch already exists from a prior run): apply `input_needed` halt protocol with reason "Worktree or branch W-<id> already exists — prior session may have left it. Manual cleanup required." `halted_at_step: "6b"`.

Record in session file: `worktree_path`, `branch`, `originating_branch`. Write `worktree_created` checkpoint.

---

### 6c — Implementation

Dispatch the **coder** agent (context tier: **standard**) in the worktree with:
- Portfolio context at standard tier + org conventions
- Full work item: title, description, session_log, all artifacts
- Approved plan.md (if present)
- Full DispatchContract (all fields: goal, constraints, expected_output, failure_conditions, scope_boundary, stop_conditions, success_criteria, e2e_test_criteria)
- Coding Standards Brief (from `domain/rules.md` → Coding Standards Brief)
- Long-Running Session Rules for medium+ complexity (from `domain/rules.md` → Long-Running Session Rules)
- `ARCHITECT_ROOT` and dashboard API endpoint for stage reporting

**Scope violation**: if coder attempts changes outside `scope_boundary`, apply `input_needed` halt protocol immediately. `halted_at_step: "6c"`, reason: "Scope boundary violation — changes attempted outside declared scope."

**Blocking question**: if coder encounters a decision it cannot resolve from context, apply `input_needed` halt protocol. `halted_at_step: "6c"`.

Write `impl_done` checkpoint after coder completes.

---

### 6d — Tests

Dispatch the **tester** agent (context tier: **full**) in the worktree:
- Run existing test suite.
- If the work item's DispatchContract contains `e2e_test_criteria`, execute each criterion as a named test scenario and report pass/fail individually per scenario. Every scenario must pass — a single failing scenario blocks merge regardless of all other results. There is no partial pass.
- Verify pre-existing contract tests pass (green) per `domain/rules.md` → Contract-First Planning Rules.
- Write new tests for new code if test infrastructure exists.

**Structured test report**: Produce the report in the format below. Omit the **E2E Scenarios** section entirely when `e2e_test_criteria` is null or absent from the DispatchContract. After producing a conforming report, persist it via `PUT /api/work-items/:id/artifacts/test-report-<session-id>.md`, write a `test_report_written` checkpoint, and record the artifact path in the session file as `test_report_artifact`.

```
## Test Report — W-<id>

### E2E Scenarios
| Scenario | Result |
|---|---|
| <exact text of e2e_test_criteria[0]> | PASS |
| <exact text of e2e_test_criteria[1]> | FAIL — <one-line reason> |

### Contract Tests
Status: PASS | FAIL
<one-line failure reason — omit line if PASS>

### Test Suite
Overall: PASS | FAIL
Framework: <name> | none detected
Results: <N passed> / <N total>
```

**Malformed report handling**: If the tester output does not conform to this format (missing section headers, missing `PASS`/`FAIL` tokens per scenario, or absent entirely): re-dispatch the tester with an explicit format request (single retry). If the second output is also non-conforming, apply the `input_needed` halt protocol. `halted_at_step: "6d"`, reason: "Tester did not produce a conforming structured test report after retry." Do not write `test_report_artifact` or dispatch 6e.

**Resume path**: If the `tests_done` checkpoint exists but `test_report_artifact` is null in the session file, re-dispatch the tester with explicit context: "Tests already passed — do NOT re-run the test suite. Produce the structured test report from existing results only." This prevents re-running the suite and avoids double-counting coder fix iterations against the 2-iteration limit.

If any test fails (unit, contract, or any named e2e scenario): dispatch coder to fix (max 2 iterations). If still failing after 2: apply `input_needed` halt protocol. `halted_at_step: "6d"`, reason: "Tests failing after 2 fix attempts — `<specify which e2e scenarios or contract tests failed, and why>`."

Write `tests_done` checkpoint after all tests pass. Write `test_report_written` checkpoint after the artifact is persisted.

---

### 6e — Code Gate

Context tier for tech-reviewer-* agents: **standard**. Tester/reviewer agents (if included): **full**.

Dispatch the Review Board (same composition rules as 6a) with:
- Implementation diff (artifact_type=diff)
- Portfolio context at standard tier for tech-reviewer-* agents
- Full DispatchContract — reviewers must evaluate whether the implementation satisfies `goal`, `success_criteria`, and `e2e_test_criteria`, not just whether code is clean
- Structured test report from 6d (read from `test_report_artifact` path in session file): named pass/fail result per `e2e_test_criteria` scenario, contract test status, overall suite result — reviewers must confirm every named e2e scenario is green and every `success_criteria` is explicitly satisfied before issuing `approve`; a general "tests pass" finding is not sufficient

Verdict handling:
- All `approve` → `code_gate_status: "passed"`. Write `code_gate_done` checkpoint. Proceed to 6f.
- Any `revise` (no `block`) → dispatch coder to address concerns; re-run board (max 2 cycles). Proceed when cleared.
- Any `block` after 2 revision cycles → apply `input_needed` halt protocol. `code_gate_status: "failed"`. `halted_at_step: "6e"`. `worktree_preserved: true`. Do not remove worktree.

**Post-board `success_criteria` coverage check** (before recording `code_gate_status: "passed"` and advancing to 6f): If `success_criteria` is non-null in the DispatchContract, scan each reviewer's verdict text (concerns + rationale) for an explicit response to the stated criterion. If no reviewer addresses it: do not advance to 6f. Dispatch coder with a targeted note — "success_criteria not addressed in Code Gate board verdict: `<success_criteria text>` — surface implementation evidence or adjust the implementation." Re-run the Code Gate board with an explicit prompt addition confirming the criterion. This re-run counts within the existing 2-cycle budget and does not add an extra cycle. If the 2-cycle budget is already exhausted, treat as `block` and apply the `input_needed` halt protocol.

---

### 6f — Commit and Merge-Back

**Merge-back conditions** (ALL must hold before merging):
1. Code Gate: all `approve`
2. Existing unit and integration test suite passes (green)
3. All pre-existing contract tests pass (green)
4. Every `e2e_test_criteria` scenario from the DispatchContract executed by name and individually verified green — partial pass is not acceptable; each named scenario must appear as passed in the 6d test report
5. All `success_criteria` from the DispatchContract explicitly confirmed satisfied by the Code Gate board — board approval of code quality alone does not satisfy this; each criterion must be addressed
6. `input_needed = false` on the work item
7. No unresolved `block` verdicts

**Commit**: Dispatch git-ops in the worktree.
- Message format: `[W-<id>] <concise subject line>` followed by a blank line and 2–4 sentences explaining why this change was made, what problem it solves, and any relevant constraints or tradeoffs. No Claude attribution.
- Commit only relevant files.
- Record `commit_sha` in session file. Write `commit_done` checkpoint.

**Merge-back**: Dispatch git-ops to merge `W-<id>` into the `originating_branch` recorded in the session file for this ticket. Fast-forward preferred, merge commit as fallback.

**Merge branch verification** (non-bypassable even in Auto-Implement Mode): after the merge, verify the commit is reachable from `originating_branch`'s HEAD via `git merge-base --is-ancestor <commit_sha> HEAD` on the originating branch. If verification fails → apply `input_needed` halt protocol. `halted_at_step: "6f"`, reason: "Merge verification failed — commit not reachable from originating branch."

On conflict: dispatch coder to resolve (max 2 attempts). If unresolvable: preserve worktree, offer `/pr` path as alternative. Apply `input_needed` halt protocol. `worktree_preserved: true`. Do not mark ticket done.

After successful merge + verification:
1. Dispatch git-ops to remove worktree and delete the `W-<id>` branch.
2. Dispatch tracker to update work item `status: "done"`.
3. `POST /api/work-items/:id/log` with `{"summary": "Implemented and merged. SHA: <sha>. Branch: W-<id> → <originating_branch>"}`.
4. Update session file: `merged: true`, `merge_verified: true`, `stage: "done"`, `commit_sha: "<sha>"`. Write `merge_done` checkpoint.

---

## Step 7 — Blocking Cases and Mid-Session Re-Evaluation

After each batch's last `merge_done` (or `item_halted`) checkpoint:

1. **Re-evaluate deferred tickets**: check all `blocked_dependency` tickets. Any whose entire `depends_on` set has `status = done` (verified via `GET /api/work-items/:id`) becomes eligible. Add to the next batch.
2. **Failure propagation**: if W-A ended as `input_needed`, any ticket with W-A in `depends_on` remains `blocked_dependency` for the rest of this session.
3. **Batch halt check** (non-bypassable in Auto-Implement Mode): if ≥50% of the batch's tickets halted as `input_needed`, surface grouped questions by theme and wait for user input before starting the next batch.
4. **Group all pending questions** by theme for the final summary — do not surface as a flat list.

---

## Step 8 — Follow-up Draft Ticket Creation

During steps 6c–6d, if the coder or tester agents identify work that is out of scope, a missing prerequisite, or non-contractual stability work:

1. Check for existing open tickets first: `GET /api/backlog` filtered to project. If a ticket with substantially the same scope already exists, add a log entry on that ticket instead of creating a duplicate.
2. If no duplicate: create via `POST /api/backlog` (max 10 follow-up tickets total per session):
   - `title`: specific and actionable
   - `description`: what was discovered, why it matters, source ticket W-XXX
   - `status`: `draft`
   - `priority`: `medium`
   - `tags`: `["follow-up", "impl-session-<session-id>"]`
3. Record IDs in the originating ticket's session file `follow_up_tickets`.

Do **not** attempt to refine or implement follow-up tickets within this session. Refinement and implementation are user-controlled and occur in separate sessions.

---

## Step 9 — Final Summary

Update session file: `status: "completed"`. Emit a `# ImplSessionSummary` block:

```json
{
  "session_id": "<session-id>",
  "completed_at": "<ISO8601>",
  "project": { "org": "...", "project": "...", "component": "..." },
  "merged": [
    { "id": "W-XXX", "title": "...", "complexity": "small", "sha": "<sha>", "merged_into": "<branch>" }
  ],
  "input_needed": [
    { "id": "W-XXX", "title": "...", "question": "...", "halted_at_step": "6c", "worktree_preserved": true }
  ],
  "skipped_dependency": [
    { "id": "W-XXX", "title": "...", "reason": "W-YYY did not complete" }
  ],
  "in_flight_gaps": [
    { "id": "W-XXX", "title": "...", "finding": "contract missing e2e_test_criteria" }
  ],
  "follow_up_created": [
    { "id": "W-NEW", "title": "...", "origin": "W-XXX" }
  ],
  "batches_executed": 2,
  "session_file": "work/impl-sessions/<session-id>.json"
}
```

---

## Hard Constraints

- Never push to `main` or any protected branch.
- Never commit without a passing Code Gate verdict.
- Never merge a worktree branch with unresolved `block` verdicts, failing tests, any unverified or failing `e2e_test_criteria` scenario, or any `success_criteria` not explicitly confirmed by the Code Gate board.
- A passing Code Gate verdict does not substitute for green `e2e_test_criteria` scenarios — both are independently required for merge. Treat a missing or partial e2e report the same as a failing test.
- Never mark a ticket `done` without a verified merge (commit reachable from originating branch HEAD).
- Never implement a ticket with `status ≠ planned`, `input_needed = true`, or unmet dependencies.
- Never create new work items without a concrete rationale from implementation discovery; cap at 10 per session; dedup before creating.
- Preserve existing `input_needed` flags — clear only if the blocking question is answered within this session.
- Sub-agents dispatched from this session must not spawn further sub-agents.
- Write session file checkpoints after every significant event — use them for resumability.
- Dashboard DB is the authoritative store for work item status; session file is metadata only.
- Include the Coding Standards Brief from `domain/rules.md` in every coder agent dispatch prompt.
- Apply role-scoped context injection per `domain/rules.md` → Role-Scoped Context Injection: tech-reviewer-* agents at standard tier, tester/reviewer agents at full tier.
- Apply dynamic model selection per `domain/rules.md` → Model Selection Rules for each dispatch.
- Non-bypassable pauses apply even in Auto-Implement Mode (see Auto-Implement Mode section above).
