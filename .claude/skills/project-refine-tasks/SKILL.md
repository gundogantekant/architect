# /project-refine-tasks

Fully automated refinement session for a target project. Fetches all non-terminal work
items, runs the three-gate refinement pipeline (pre-board → coordinator → Contract Gate →
post-board), and brings every eligible item to `planned` status with a complete,
board-validated DispatchContract. No per-item user confirmation gates after session start.

## Entry Point

Dashboard-driven: `POST /api/projects/:org/:proj/:comp/refine` (background dispatch) or
`POST /api/projects/:org/:proj/:comp/refine-terminal` (PTY session). The refinement flow
is orchestrated by this skill from the CLI; the actual agent session runs via the dashboard.

## Depth Constraint

Must run at depth 0 only. If invoked from inside a dispatched session or at depth ≥ 1,
halt immediately: "project-refine-tasks must run at depth 0. Re-invoke from the CLI."

## Agents Dispatched

- `tech-reviewer-swe`, `tech-reviewer-arch`, `tech-reviewer-pm` + context-dependent reviewers — Pre-Refinement Board (5a) per item
- `coordinator` — contract drafting per item (5c)
- `tech-reviewer-swe`, `tech-reviewer-arch`, `tech-reviewer-pm` — Contract Gate (5d) per item
- `tech-reviewer-swe`, `tech-reviewer-arch`, `tech-reviewer-pm` + context-dependent reviewers — Post-Refinement Board (5e) per item
- `tracker` — status updates

## Steps

1. **Resolve target project** from args or cwd. Required fields: Organization, Project,
   Component, Path, Branch. If any field is ambiguous, ask before proceeding.
   For architect self-work: Organization=ticari, Project=architect, Component=main.

2. **Load portfolio context**: Follow `usecases/load-portfolio-context.md` with depth **standard**.

3. **Verify dashboard**: `GET http://127.0.0.1:3777/api/server/status`. If unreachable:
   halt — "Start the dashboard first: `tools/dashboard/dashctl.sh start`". Do not proceed
   without a running dashboard.

4. **Execute session**: Trigger `POST /api/projects/:org/:proj/:comp/refine` to launch the
   background refinement agent. Monitor the dispatch panel; the session runs autonomously.
   Mandatory gates:
   - Pre-Refinement Board (5a) per item
   - Contract Gate (5d) per item
   - Post-Refinement Board (5e) per item
   - Batch halt threshold (≥50% block rate in any batch)

   Non-bypassable pauses (user instruction required before continuing):
   - Any pre-board `block` (item skipped, not session halted)
   - Contract Gate exhausted after cycle 2 (item skipped)
   - Post-board exhausted after 2 revision cycles (item skipped)
   - ≥50% block rate in a batch → **session halted**, user instruction required

## Output

- `# RefinementSummary` block emitted by the refinement agent at session end
- Session file at `work/refinement-sessions/<session-id>.json`
- Items requiring input surfaced in Step 8 output
