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

## Agent(s)
- **coder** (model: sonnet) — implementation
- **tester** (model: sonnet) — test verification
- **git-ops** (model: haiku) — commit and branch operations
- **tracker** (model: haiku, data-write) — status update

## Steps

1. **Fetch work item details**: `GET /api/work-items/<id>` — read title, description, priority, tags, epic_id, depends_on, session_log. Check for stored artifacts via `GET /api/work-items/<id>/artifacts` (especially plan.md).

2. **Guard checks**:
   - If status is `done` or `cancelled`, warn user and confirm before proceeding.
   - If `depends_on` contains items that are not `done`, warn user about unmet dependencies.

3. **Update status**: `PATCH /api/work-items/<id>` with `{"status": "in-progress"}`.

4. **Brief investigation**: Read relevant files based on work item description and portfolio context. Keep exploration to understanding the change surface — identify which files need changes, what patterns exist, any dependencies or constraints. Do not do a full codebase scan.

5. **Plan implementation**: Produce a bullet-point plan (max 5 points) covering: files to modify/create, approach summary, test strategy. If the work item has a stored `plan.md` artifact, use it as the basis instead of generating from scratch. Present to user for confirmation. If rejected, refine or abort.

6. **Write contract tests** (if applicable per `domain/rules.md` → Contract-First Planning Rules): When the plan introduces new API endpoints, UI interactions, or dispatch flows, write E2E/integration tests that encode the expected behavior before implementation. Verify they fail (red). Trivial changes are exempt.

7. **Create worktree**: Follow `usecases/manage-worktree.md` → create, using the work item ID as the ticket ID and the work item title as the task description. Respect the portfolio entry's `worktree_mode` field — if `"explicit"`, work in-place.

8. **Implement changes**: Dispatch coder agent in the worktree with: portfolio context, work item details, the approved plan, and the coding standards brief from `domain/rules.md`.

9. **Run tests**: Dispatch tester agent in the worktree. Run existing test suite if available. Write new tests if new code warrants them and the project has test infrastructure. If contract tests were written in step 6, verify they now pass (green). If tests fail: dispatch coder to fix, then re-run tester (max 2 iterations). If no test framework is detected, skip and note it in the output.

10. **Commit**: Dispatch git-ops to commit in the worktree. Message format: `<W-XXX>: <concise description of changes>`. Commit only relevant files. No Claude attribution per project rules.

11. **Log progress**: `POST /api/work-items/<id>/log` with `{"message": "Implemented: <summary>. Branch: <branch-name>"}`.

12. **Update status**: Dispatch tracker agent with command `update <id> done`. If the item has an `epic_id`, tracker checks epic progress and suggests status transition.

13. **Present results**: Summarize changes made, test results, commit hash, and branch name. Offer `/pr` to create a pull request from the worktree branch, or `/worktree cleanup` to discard.

## Post-conditions
- All changes are committed in a worktree branch (not pushed)
- Work item status is `done`
- Session log records the implementation summary and branch name
- User can follow up with `/pr` or `/worktree cleanup`
