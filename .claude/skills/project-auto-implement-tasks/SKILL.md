# /project-auto-implement-tasks

Fully automated batch implementation for a target project. Iterates the project's auto-implement-eligible work items (status `planned` or `in-progress` with all `depends_on` resolved per `domain/rules.md` → Auto-Implement Eligibility Rules) and creates one auto-implement dispatch per item via `POST /api/dispatch/auto-implement`. Each dispatch runs in its own worktree under skip-permissions semantics; multiple dispatches execute concurrently and report progress to the dashboard. No per-item user confirmation after session start.

## Delegates to

- `usecases/implement-work-item.md` — the agent-side workflow each dispatch runs (with `# Auto-Implement Mode` injected so the agent skips user-confirmation pauses).
- `usecases/autonomous-pipeline.md` — the server-side pipeline that handles the completion signal, pre-merge gate, merge, and worktree/branch cleanup.
- `domain/rules.md` → Auto-Implement Eligibility Rules, Auto-Implement Failure Protocol, Autonomous Pipeline Rules — the authoritative rules for eligibility, failure handling, and merge gating.

## Depth Constraint

Must run at depth 0 only. If invoked from inside a dispatched session or at depth ≥ 1, halt immediately: "project-auto-implement-tasks must run at depth 0. Re-invoke from the CLI." The `/api/dispatch/auto-implement` endpoint enforces the same constraint at the API boundary via the `X-Architect-Session-Depth` header.

## Agents Dispatched

Per dispatched ticket (each runs `usecases/implement-work-item.md`):

- `coder` — implementation
- `tester` — test verification
- `tech-reviewer-*` board (context-filtered) — Code Gate (for non-trivial changes)
- `git-ops` — commit
- `tracker` — status updates

Merge-back, worktree removal, and final status transition to `done` are handled server-side by the autonomous pipeline (`usecases/autonomous-pipeline.md`) after the agent signals completion — no separate agents needed.

## Steps

1. **Resolve target project** from args or cwd. Required fields: Organization, Project, Component, Path, Branch. If any field is ambiguous, ask before proceeding. For architect self-work: Organization=ticari, Project=architect, Component=main.

2. **Load portfolio context**: Follow `usecases/load-portfolio-context.md` with depth **standard**.

3. **Verify dashboard**: `GET http://127.0.0.1:3777/api/server/status`. If unreachable: halt — "Start the dashboard first: `tools/dashboard/dashctl.sh start`". Do not proceed without a running dashboard.

4. **Select eligible work items**: `GET /api/backlog` scoped to the target project. Filter to items whose status and dependencies satisfy `domain/rules.md` → Auto-Implement Eligibility Rules. If the eligible set is empty, halt and report.

5. **Dispatch each eligible item**: For each item, `POST /api/dispatch/auto-implement` with `{ "work_item_id": "W-XXX" }`. The endpoint creates a worktree, spawns a Claude agent with `--dangerously-skip-permissions`, and returns a dispatch ID. Failures from this endpoint (400/403) carry user-facing reasons from the eligibility rules — surface them and continue with the next item.

6. **Report**: After all dispatches are accepted, present the list of dispatch IDs and their associated work items. Live progress streams to the dashboard; the autonomous pipeline handles merge gating per `DashboardPreferences.merge_gate` (`confirm` requires human click in the UI; `auto` merges after a short delay).

## Output

- List of dispatch IDs created, keyed by work item ID
- Pointer to the dashboard for live progress and the pre-merge gate
- Items rejected by the eligibility gate, with the rejection reason from the endpoint

## Monitor Loop Limitation

The `/loop`-based orchestrator monitor is tied to the session process. If the orchestrator session disconnects or is interrupted, the monitoring loop dies with no auto-recovery. To reconnect monitoring after a session restart, check dispatch status via `GET /api/dispatch/active` and re-arm `/loop` manually.
