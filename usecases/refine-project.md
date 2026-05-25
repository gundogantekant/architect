# Refine Project

Triggers when "Refine Project" is clicked on a component view in the dashboard.

## Steps
1. User clicks "Refine Project" button on component view — confirmation modal opens showing in-scope item count, grouped list by status, dry-run toggle.
2. User confirms → `POST /api/projects/:org/:proj/:comp/refine` (with optional `{ instructions, dry_run }`).
3. Server validates: project exists in registry → 404 if not. Checks for live `project_refinement` dispatch on same project_key with PID-liveness → 409 if active.
4. Server loads per-project template (seeds from `templates/refinement-template.md` on first read), snapshots non-terminal items (`{draft, planned, blocked}`) and in-scope epics, builds prompt via `buildProjectRefinementPrompt`.
5. Server spawns `claude -p --permission-mode plan --output-format stream-json --verbose` with the rendered prompt. Returns `{ dispatch_id, accepted: true }` — live output streams in dispatch panel.
6. **Session-Level Plan Gate (dispatched agent, runs once, background dispatch only)**: Before iterating items, the dispatched agent produces a session plan (items in scope, refinement approach, known blockers), then dispatches tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, tech-reviewer-dx in parallel via Agent tool (Agent tool calls from depth-1 are in-process — no additional spawn depth). Aggregates verdicts: block → log reason and halt dispatch; revise → note concerns in session log and continue (background dispatch — no user approval loop possible); all approve → proceed to item iteration. **Terminal-path exemption**: This gate runs only in background dispatch mode. Terminal-path sessions are exempt — the user is the review gate (see Terminal Path below).
7. Dispatched agent (depth 1) iterates items in priority+dependency-topological order: pre-refinement board → targeted research → refine → post-refinement board → PATCH item → log entry. Repeats for each item.
8. Agent performs epic pass: verifies epic state correctness and plan artifact existence.
9. Agent emits `# RefinementSummary` fenced JSON block at session end.
10. On dispatch completion: close handler parses `# RefinementSummary`, persists to `dispatches.completion_summary`.
11. Frontend refreshes component view — "Refinement in progress" badge disappears, "Refine Project" button re-enables.

## Terminal Path

Triggered via `POST /api/projects/:org/:proj/:comp/refine-terminal`. Returns `{ terminal_id, accepted: true }`. The session appears in the dashboard alongside other terminal sessions.

**Gate-exemption rationale**: The terminal path is supervised — the user is present in an interactive PTY session and can observe and intervene at any point. The plan-gate review board is intentionally skipped here; it exists for autonomous background dispatches where no human supervises execution. In an interactive session, the user IS the review gate.

**Supervised-session rule**: Agents dispatched via the terminal path always run in `plan` permission mode — never `acceptEdits`. The user must explicitly approve any code changes interactively. This prevents terminal-path refinement from making unreviewed edits.

**Item filter**: The terminal path filters `draft` + `planned` items only — `blocked` items are excluded. Background `/refine` includes blocked items because surfacing them in an unsupervised context is appropriate; in an interactive session the user handles blocked items in real time, so auto-surfacing them would distract from the core refinement task.
