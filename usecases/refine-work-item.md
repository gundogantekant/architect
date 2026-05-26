# Refine Work Item

Triggers when a "Refine" button is clicked on a draft work item in the board view.

## Steps
1. POST /api/work-items/:id/refine
2. Server validates: item exists, status is draft
3. Server dispatches coordinator with dispatch_mode='refinement', prompt from buildRefinementPrompt(workItem). Returns { dispatch_id, accepted: true } — live output streams in dispatch panel.
4. **Plan Gate (coordinator-internal, runs once)**: Coordinator produces a brief refinement plan (item scope, approach, expected contract shape), then dispatches tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, tech-reviewer-dx in parallel via Agent tool (in-process, never via dashboard dispatch). Aggregates verdicts: block → log reason to work item session log and halt dispatch; revise → note concerns in session log and proceed (background dispatch — no user approval loop possible); all approve → continue to refinement.
5. On dispatch completion: close handler finds # DispatchContract fenced JSON block in output.
6. Applies contract fields to work item description; transitions status to planned (single DB call).
7. Frontend refreshes work item row to show planned status.
