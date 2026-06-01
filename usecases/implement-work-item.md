# Use Case: Implement Work Item

Implement a tracked work item end-to-end: investigate, plan, code, test, commit, and update status.

## Input
- Work item ID (W-XXX format)
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Implementation changes committed in a worktree branch
- Test results
- Work item status updated to `done`

## Preconditions
- Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: run scout to detect the stack)
- Dashboard must be running at `http://127.0.0.1:3777`
- For medium+ complexity work items, the DispatchPlan must include a `contract` on each step per `domain/rules.md` → Dispatch Contract Rules. If contracts are missing, the orchestrator constructs them from the work item description before dispatching.
- **Autonomous mode**: When the prompt contains a `# Auto-Implement Mode` section, proceed through all steps without pausing for user confirmation at intermediate gates. The only exception: if a Technical Review Board gate returns `block` after 2 revision cycles, halt and mark the dispatch as failed. After step 12 (commit) succeeds, call `POST /api/dispatch/${DISPATCH_ID}/complete` (see step 12 sub-step below) and then **halt** — the dashboard handles steps 13–16 (merge-back, cleanup, status update) automatically.

## Agent(s)
- **coder** (model: sonnet) — implementation
- **tester** (model: sonnet) — test verification
- **git-ops** (model: haiku) — commit and branch operations
- **tracker** (model: haiku, data-write) — status update
- **tech-reviewer-swe** (model: sonnet, read-only) — SWE review (always)
- **tech-reviewer-arch** (model: sonnet, read-only) — architecture review (always)
- **tech-reviewer-pm** (model: sonnet, read-only) — PM review (always)
- **tech-reviewer-frontend** (model: sonnet, read-only) — frontend review (context-dependent)
- **tech-reviewer-ux** (model: sonnet, read-only) — UX review (context-dependent)
- **tech-reviewer-dx** (model: sonnet, read-only) — DX review (context-dependent)
- **tech-reviewer-dba** (model: sonnet, read-only) — database review (context-dependent)
- **tech-reviewer-systems** (model: sonnet, read-only) — systems review (context-dependent)
- **tech-reviewer-iot** (model: sonnet, read-only) — IoT review (context-dependent)

## Steps

1. **Fetch work item details**: `GET /api/work-items/<id>` — read title, description, priority, tags, epic_id, depends_on, session_log, flags (`input_needed`, `approval_active`). Check for stored artifacts via `GET /api/work-items/<id>/artifacts` (especially plan.md).

2. **Guard checks**:
   - If status is `done` or `cancelled`, warn user and confirm before proceeding.
   - If status is not `planned`, warn user — items must be in `planned` state before dispatch. Prompt to transition to `planned` or abort.
   - If `input_needed` flag is set, surface the pending question to the user and wait for resolution before proceeding.
   - If `approval_active` flag is set, inform user that approval is pending and halt — do not proceed until the flag is cleared.
   - If `depends_on` contains items that are not `done`, warn user about unmet dependencies.

2b. **Blocking question protocol** (applies at any step during execution): If at any point during steps 4–12 the agent encounters a decision that cannot be resolved from context, portfolio knowledge, or the work item description, do NOT guess. Take these actions immediately:
   1. `PATCH /api/work-items/<id>` with `{"input_needed": true, "input_needed_reason": "<specific question>", "input_needed_from": "user"}`
   2. `POST /api/work-items/<id>/log` with `{"summary": "Halted: input needed — <question>"}`
   3. Halt immediately — do not continue implementing.

   On re-dispatch: the user provides the answer via "Additional Instructions". The agent reads the session log to find the halt reason, then reads `additional_instructions` for the answer before resuming. On re-dispatch, clear the flag: `PATCH /api/work-items/<id>` with `{"input_needed": false}`.

3. **Update status**: `PATCH /api/work-items/<id>` with `{"status": "in-progress"}`.

4. **Brief investigation**: Read relevant files based on work item description and portfolio context. Keep exploration to understanding the change surface — identify which files need changes, what patterns exist, any dependencies or constraints. Do not do a full codebase scan. **Auto-Implement Mode**: report stage — `PUT /api/dispatch/${DISPATCH_ID}/stage` with `{"stage": "investigating"}`.

5. **Plan implementation**: Produce a bullet-point plan (max 5 points) covering: files to modify/create, approach summary, test strategy. If the work item has a stored `plan.md` artifact, use it as the basis instead of generating from scratch. Present to user for confirmation. If rejected, refine or abort.

6. **Review Board — Plan Gate** (if medium+ complexity per `domain/rules.md` → Review Board Rules): Assemble the review board using context-based composition rules (3–10 agents). Dispatch all selected tech-reviewer-* agents **in parallel** with the plan text, artifact_type=plan, and target project portfolio context. Collect `TechReviewVerdict` from each. Apply aggregation rules:
   - Any `block` → feed concerns back to planner for revision, re-review (max 2 cycles). If still blocked after 2 cycles, escalate to user.
   - Any `revise` (no `block`) → present plan to user WITH revision concerns highlighted. User decides: accept, revise, or override.
   - All `approve` → update work item status to `ready`. Proceed to user confirmation (step 5 already handles this).
   Skip this step for trivial/small complexity. User-provided plans for medium+ work items must still pass the Plan Gate — the board reviews the plan regardless of its origin.

7. **Write contract tests** (if applicable per `domain/rules.md` → Contract-First Planning Rules): When the plan introduces new API endpoints, UI interactions, or dispatch flows, write E2E/integration tests that encode the expected behavior before implementation. When `contract.e2e_test_criteria` is present, use each entry directly as a test scenario description — each criterion becomes one test case. Verify all tests fail (red) before implementation. Trivial changes are exempt.

8. **Worktree check**: If a `# Worktree Context` section is present in your prompt (i.e., the dispatch infrastructure already created a worktree and set your working directory to it), skip worktree creation and proceed to step 9. Otherwise, follow `usecases/manage-worktree.md` → create, using the work item ID as the ticket ID (branch and directory will be named `W-<id>`). Respect the portfolio entry's `worktree_mode` field — if `"explicit"`, work in-place.

9. **Implement changes**: Dispatch coder agent in the worktree with: portfolio context, work item details, the approved plan, the coding standards brief from `domain/rules.md`, and the full DispatchContract (goal, constraints, expected output, failure conditions, scope_boundary, stop_conditions, success_criteria, e2e_test_criteria) from the DispatchPlan step. For medium+ complexity, the agent must follow `domain/rules.md` → Long-Running Session Rules (phase-based progress checkpoints, scope boundary self-enforcement, stop condition protocol). **Auto-Implement Mode**: report stage — `PUT /api/dispatch/${DISPATCH_ID}/stage` with `{"stage": "implementing"}`.

10. **Run tests**: Dispatch tester agent in the worktree. Run existing test suite if available. Write new tests if new code warrants them and the project has test infrastructure. If contract tests were written in step 7, verify they now pass (green). If tests fail: dispatch coder to fix, then re-run tester (max 2 iterations). If no test framework is detected, skip and note it in the output. **Auto-Implement Mode**: report stage — `PUT /api/dispatch/${DISPATCH_ID}/stage` with `{"stage": "testing"}`.

    The tester must emit a **structured Test Report** in this exact format before step 11 can begin:

    ```
    ## Test Report
    **Overall**: PASS | FAIL
    **Contract tests**: PASS | FAIL | SKIP (no contract tests written)
    **E2E Scenarios**:
    | Scenario | Status |
    |----------|--------|
    | <exact text of contract.e2e_test_criteria[0]> | PASS |
    | <exact text of contract.e2e_test_criteria[1]> | FAIL — <one-line reason> |
    ```

    Omit the `E2E Scenarios` section when `contract.e2e_test_criteria` is null or absent. **No-partial-pass rule**: every named e2e scenario must pass — a single failing scenario blocks the Code Gate, regardless of overall suite result. If the report is malformed or missing required fields, re-dispatch the tester once with the format requirement restated; if still non-conforming, halt and mark the Code Gate as blocked.

11. **Review Board — Code Gate** (for all non-trivial code changes per `domain/rules.md` → Review Board Rules): Assemble the review board using context-based composition rules. Dispatch all selected tech-reviewer-* agents **in parallel** with the implementation diff (artifact_type=diff), target project portfolio context, and the DispatchContract so reviewers can evaluate whether the implementation meets the stated goals and does not violate the stated constraints. When `success_criteria` is present in the contract, include it in each reviewer's prompt so they can evaluate whether the implementation satisfies the stated done conditions. Collect `TechReviewVerdict` from each. Apply aggregation rules:
    - Any `block` → dispatch coder to fix, re-review (max 2 cycles). If still blocked, escalate to user.
    - Any `revise` (no `block`) → present to user WITH revision concerns highlighted. User decides: accept, request fix, or override.
    - All `approve` → proceed to commit.
    **Auto-Implement Mode**: report stage — `PUT /api/dispatch/${DISPATCH_ID}/stage` with `{"stage": "code_review"}`.

    **success_criteria coverage check**: After aggregation, when `contract.success_criteria` is non-null, scan each reviewer's verdict for an explicit response to each success criterion. If any criterion is unaddressed by every reviewer, re-dispatch the coder with a targeted note naming the unaddressed criteria, then re-run the Code Gate. This check shares the same 2-cycle budget as the `block` revision loop above; if the budget is exhausted, block the Code Gate and escalate. Skip this check entirely (do not emit a coverage section) when `contract.success_criteria` is null or absent.

12. **Commit**: Dispatch git-ops to commit in the worktree. Message format: `<W-XXX>: <concise description of changes>`. Commit only relevant files. No Claude attribution per project rules. **Auto-Implement Mode**: report stage — `PUT /api/dispatch/${DISPATCH_ID}/stage` with `{"stage": "committing"}` before dispatching git-ops.

    **Auto-Implement Mode sub-step**: After the commit succeeds, retrieve the commit SHA (`git rev-parse HEAD`) and signal completion to the dashboard:
    ```
    curl -s -X POST http://127.0.0.1:${PORT}/api/dispatch/${DISPATCH_ID}/complete \
      -H 'Content-Type: application/json' \
      -H 'X-Architect-Session-Depth: 1' \
      -d '{"sha": "<commit-sha>", "summary": "<one-line summary of what was implemented>"}'
    ```
    The `${PORT}` and `${DISPATCH_ID}` values are injected into the prompt by the dashboard at dispatch time. After calling this endpoint, halt. Do not proceed to steps 13–16.

13. **Note (Auto-Implement Mode)**: Steps 13–16 are skipped in Auto-Implement Mode — the dashboard autonomous pipeline handles merge-back confirmation, merge execution, worktree cleanup, and work item status update automatically after receiving the completion signal in step 12.

    **Log progress**: `POST /api/work-items/<id>/log` with `{"message": "Implemented: <summary>. Branch: <branch-name>"}`.

14. **Merge-back confirmation**: Present a one-line summary: "Ready to merge <N> commit(s) from `<branch>` into `<originating_branch>`. Proceed?" Wait for user confirmation before continuing.

    Before requesting confirmation, verify the **Merge-Back Checklist** — all 7 conditions are a hard gate; any unsatisfied condition blocks the merge:
    1. Code Gate aggregate verdict is `approve` (no outstanding `block` or `revise`).
    2. Full test suite is green.
    3. Contract tests pass green (or were exempted per step 7).
    4. Every entry in `contract.e2e_test_criteria` is individually reported as PASS in the step-10 Test Report.
    5. When `contract.success_criteria` is non-null, each criterion is explicitly confirmed by the Code Gate board (per the coverage check in step 11).
    6. The work item's `input_needed` flag is not set.
    7. The worktree has no uncommitted changes.

15. **Merge-back**: Dispatch git-ops to merge the worktree branch into the originating branch (fast-forward preferred, merge commit fallback). On success: remove the worktree, delete the branch, then proceed to step 16. On conflict: dispatch the coder agent to attempt resolution — it must (a) identify the conflicting hunks, (b) produce a resolution, and (c) provide an impact analysis (what changed semantically, risk level). If the coder agent's resolution is clean and low-risk, apply it, complete the merge, and proceed to step 16. If the conflict cannot be meaningfully resolved (risk too high, intent unclear, or multiple overlapping changes), run `git merge --abort`, preserve the worktree intact, report the conflicting files with a brief conflict summary, and offer two options: (a) run `/pr` to push a pull request instead, or (b) leave the worktree open for manual resolution. Do not proceed to step 16 on unresolved conflict.

16. **Update status + present results**: Dispatch tracker to mark item `done`. If the item has an `epic_id`, tracker checks epic progress and suggests status transition. Log: `POST /api/work-items/<id>/log` with the merge commit hash and originating branch. Summarize: changes made, test results, merge commit hash, and target branch. Note: run `/pr` explicitly if a GitHub pull request is needed.

## Post-conditions
- Changes are committed and merged into the originating branch
- Worktree and branch are removed
- Work item status is `done` (set only after successful merge)
- Session log records the implementation summary and merge commit hash
- User can run `/pr` explicitly if a GitHub pull request is needed

## Orchestrator Monitor Rules

After dispatching a work item via `POST /api/dispatch/auto-implement`, the orchestrator SHOULD arm a `/loop` that wakes every 10 minutes to monitor the dispatch.

### Per-Poll Steps

1. `GET /api/dispatch/active` — find dispatches with `work_item_id` matching the dispatched item
2. Bootstrap cursor on first poll: `max(total_output_lines - 50, 0)` so only recent lines are read.
   Advance cursor: `cursor = new_total_lines` after each poll
3. `GET /api/dispatch/:id/log?after=<cursor>` — fetch only new lines (O(new_lines), not O(file))
4. Emit structured 5-line summary:

```
[Monitor W-XXXX] <ISO timestamp>
Status    : <running|done|failed|interrupted>
Phase     : <dispatch.lastProgressPhase or "unknown">
Last line : <last non-JSON output line, ≤120 chars>
Idle since: <duration since dispatch.lastOutputAt or "active">
Action    : <"none" | "input_needed — check dashboard" | "done — ready to review">
```

If `input_needed=true` on the work item: always set `Action = "input_needed — check dashboard"`.

End the loop when all monitored dispatches reach terminal status (done|failed|killed|interrupted).

### Known Limitations

- **Session disconnect**: the `/loop` runs in the orchestrator session process. Session disconnect terminates the loop with no auto-recovery. Re-arm by re-running the orchestrator and checking dispatch status.
- **Cursor not persistent**: cursor is an in-session variable; it is lost on session disconnect.
- **SSE broadcast**: `broadcastDispatchLine` is best-effort for active SSE clients only. Progress events on completed dispatches (no `wsClients`) are appended to JSONL but not delivered via SSE.
- **lastProgressPhase after restart**: in-memory only. Shows "unknown" after server restart even for active dispatches. JSONL is the source of truth; scan log to re-derive last phase if needed.
- **Soft-timeout relationship**: `scheduleDispatchTimeout` fires at 80% idle window and sets `input_needed=true`. The monitor loop reads this output — it does not duplicate idle-detection logic. Do not modify `IDLE_THRESHOLD_MS`.
