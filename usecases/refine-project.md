# Refine Project

Triggers when "Refine Project" is clicked on a component view in the dashboard.

## Steps
1. User clicks "Refine Project" button on component view — confirmation modal opens showing in-scope item count, grouped list by status, dry-run toggle.
2. User confirms → `POST /api/projects/:org/:proj/:comp/refine` (with optional `{ instructions, dry_run }`).
3. Server validates: project exists in registry → 404 if not. Checks for live `project_refinement` dispatch on same project_key with PID-liveness → 409 if active.
4. Server loads per-project template (seeds from `templates/refinement-template.md` on first read), snapshots non-terminal items (`{draft, planned, blocked}`) and in-scope epics, builds prompt via `buildProjectRefinementPrompt`.
5. Server spawns `claude -p --permission-mode plan --output-format stream-json --verbose` with the rendered prompt. Returns `{ dispatch_id, accepted: true }` — live output streams in dispatch panel.
6. Dispatched agent (depth 1) iterates items in priority+dependency-topological order: pre-refinement board → targeted research → refine → post-refinement board → PATCH item → log entry. Repeats for each item.
7. Agent performs epic pass: verifies epic state correctness and plan artifact existence.
8. Agent emits `# RefinementSummary` fenced JSON block at session end.
9. On dispatch completion: close handler parses `# RefinementSummary`, persists to `dispatches.completion_summary`.
10. Frontend refreshes component view — "Refinement in progress" badge disappears, "Refine Project" button re-enables.
