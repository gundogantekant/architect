# /project-auto-implement-tasks

Fully automated implementation session for a target project. Fetches all eligible work items, produces a batch roadmap, runs a Roadmap Review Board (tech-reviewer-pm + tech-reviewer-arch), and — on board approval — executes all tickets concurrently in isolated worktrees under skip-permissions semantics. No per-ticket user confirmation gates after board approval.

## Delegates to
`.claude/prompt-bases/implement-session.md` — executed with Auto-Implement Mode active (via `# Auto-Implement Mode` section prepended to the prompt) and `--dangerously-skip-permissions` passed to all subsequent agent dispatches.

## Depth Constraint
Must run at depth 0 only. If invoked from inside a dispatched session or at depth ≥ 1, halt immediately: "project-auto-implement-tasks must run at depth 0. Re-invoke from the CLI."

## Agents Dispatched
- `tech-reviewer-pm`, `tech-reviewer-arch` — Roadmap Review Board (implement-session.md Step 5)
- `coder` — implementation per ticket
- `tester` — test verification per ticket
- `tech-reviewer-*` board (context-filtered) — Code Gate per ticket
- `git-ops` — commit + merge-back per ticket
- `tracker` — status updates per ticket

## Steps

1. **Resolve target project** from args or cwd. Required fields: Organization, Project, Component, Path, Branch. If any field is ambiguous, ask before proceeding. For architect self-work: Organization=ticari, Project=architect, Component=main.

2. **Load portfolio context**: Follow `usecases/load-portfolio-context.md` with depth **standard**.

3. **Verify dashboard**: `GET http://127.0.0.1:3777/api/server/status`. If unreachable: halt — "Start the dashboard first: `tools/dashboard/dashctl.sh start`". Do not proceed without a running dashboard.

4. **Execute session**: Load `.claude/prompt-bases/implement-session.md`. Prepend a `# Auto-Implement Mode` section to the prompt so the session recognizes auto mode. Pass `--dangerously-skip-permissions` for all subsequent agent dispatches within the session. The session runs Steps 1–9 of implement-session.md autonomously; the Roadmap Review Board in Step 5 is the mandatory gate before execution begins.

## Output
- `# ImplSessionSummary` block (from implement-session.md Step 9)
- Session file at `work/impl-sessions/<session-id>.json`
- Follow-up draft tickets for any out-of-scope discoveries
