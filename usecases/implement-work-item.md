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

1. **Fetch work item details**: `GET /api/work-items/<id>` — read title, description, priority, tags, epic_id, depends_on, session_log. Check for stored artifacts via `GET /api/work-items/<id>/artifacts` (especially plan.md).

2. **Guard checks**:
   - If status is `done` or `cancelled`, warn user and confirm before proceeding.
   - If `depends_on` contains items that are not `done`, warn user about unmet dependencies.

3. **Update status**: `PATCH /api/work-items/<id>` with `{"status": "in-progress"}`.

4. **Brief investigation**: Read relevant files based on work item description and portfolio context. Keep exploration to understanding the change surface — identify which files need changes, what patterns exist, any dependencies or constraints. Do not do a full codebase scan.

5. **Plan implementation**: Produce a bullet-point plan (max 5 points) covering: files to modify/create, approach summary, test strategy. If the work item has a stored `plan.md` artifact, use it as the basis instead of generating from scratch. Present to user for confirmation. If rejected, refine or abort.

6. **Review Board — Plan Gate** (if medium+ complexity per `domain/rules.md` → Review Board Rules): Assemble the review board using context-based composition rules (3–10 agents). Dispatch all selected tech-reviewer-* agents **in parallel** with the plan text, artifact_type=plan, and target project portfolio context. Collect `TechReviewVerdict` from each. Apply aggregation rules:
   - Any `block` → feed concerns back to planner for revision, re-review (max 2 cycles). If still blocked after 2 cycles, escalate to user.
   - Any `revise` (no `block`) → present plan to user WITH revision concerns highlighted. User decides: accept, revise, or override.
   - All `approve` → update work item status to `ready`. Proceed to user confirmation (step 5 already handles this).
   Skip this step for trivial/small complexity or when the plan was provided by the user.

7. **Write contract tests** (if applicable per `domain/rules.md` → Contract-First Planning Rules): When the plan introduces new API endpoints, UI interactions, or dispatch flows, write E2E/integration tests that encode the expected behavior before implementation. Verify they fail (red). Trivial changes are exempt.

8. **Worktree check**: If a `# Worktree Context` section is present in your prompt (i.e., the dispatch infrastructure already created a worktree and set your working directory to it), skip worktree creation and proceed to step 9. Otherwise, follow `usecases/manage-worktree.md` → create, using the work item ID as the ticket ID (branch and directory will be named `W-<id>`). Respect the portfolio entry's `worktree_mode` field — if `"explicit"`, work in-place.

9. **Implement changes**: Dispatch coder agent in the worktree with: portfolio context, work item details, the approved plan, the coding standards brief from `domain/rules.md`, and the full DispatchContract (goal, constraints, expected output, failure conditions, scope_boundary, stop_conditions) from the DispatchPlan step. For medium+ complexity, the agent must follow `domain/rules.md` → Long-Running Session Rules (phase-based progress checkpoints, scope boundary self-enforcement, stop condition protocol).

10. **Run tests**: Dispatch tester agent in the worktree. Run existing test suite if available. Write new tests if new code warrants them and the project has test infrastructure. If contract tests were written in step 7, verify they now pass (green). If tests fail: dispatch coder to fix, then re-run tester (max 2 iterations). If no test framework is detected, skip and note it in the output.

11. **Review Board — Code Gate** (for all non-trivial code changes per `domain/rules.md` → Review Board Rules): Assemble the review board using context-based composition rules. Dispatch all selected tech-reviewer-* agents **in parallel** with the implementation diff (artifact_type=diff), target project portfolio context, and the DispatchContract so reviewers can evaluate whether the implementation meets the stated goals and does not violate the stated constraints. Collect `TechReviewVerdict` from each. Apply aggregation rules:
    - Any `block` → dispatch coder to fix, re-review (max 2 cycles). If still blocked, escalate to user.
    - Any `revise` (no `block`) → present to user WITH revision concerns highlighted. User decides: accept, request fix, or override.
    - All `approve` → proceed to commit.

12. **Commit**: Dispatch git-ops to commit in the worktree. Message format: `<W-XXX>: <concise description of changes>`. Commit only relevant files. No Claude attribution per project rules.

13. **Log progress**: `POST /api/work-items/<id>/log` with `{"message": "Implemented: <summary>. Branch: <branch-name>"}`.

14. **Merge-back confirmation**: Present a one-line summary: "Ready to merge <N> commit(s) from `<branch>` into `<originating_branch>`. Proceed?" Wait for user confirmation before continuing.

15. **Merge-back**: Dispatch git-ops to merge the worktree branch into the originating branch (fast-forward preferred, merge commit fallback). On success: remove the worktree, delete the branch, then proceed to step 16. On conflict: dispatch the coder agent to attempt resolution — it must (a) identify the conflicting hunks, (b) produce a resolution, and (c) provide an impact analysis (what changed semantically, risk level). If the coder agent's resolution is clean and low-risk, apply it, complete the merge, and proceed to step 16. If the conflict cannot be meaningfully resolved (risk too high, intent unclear, or multiple overlapping changes), run `git merge --abort`, preserve the worktree intact, report the conflicting files with a brief conflict summary, and offer two options: (a) run `/pr` to push a pull request instead, or (b) leave the worktree open for manual resolution. Do not proceed to step 16 on unresolved conflict.

16. **Update status + present results**: Dispatch tracker to mark item `done`. If the item has an `epic_id`, tracker checks epic progress and suggests status transition. Log: `POST /api/work-items/<id>/log` with the merge commit hash and originating branch. Summarize: changes made, test results, merge commit hash, and target branch. Note: run `/pr` explicitly if a GitHub pull request is needed.

## Post-conditions
- Changes are committed and merged into the originating branch
- Worktree and branch are removed
- Work item status is `done` (set only after successful merge)
- Session log records the implementation summary and merge commit hash
- User can run `/pr` explicitly if a GitHub pull request is needed
