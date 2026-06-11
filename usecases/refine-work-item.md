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

## Failure Handling

These cases cover all paths where a refinement session cannot produce a valid DispatchContract. In every case: do NOT call PATCH to change the work item status — the item remains `draft`. Write a session log entry via `POST /api/work-items/:id/log` before halting.

### Case A — Session interrupted before DispatchContract appears

Detected after the fact: the coordinator session ends (token limit, timeout, network cut, or model interruption) without a `# DispatchContract` fenced JSON block in its output. The close handler or agent detects the absence when inspecting final output.

- Do NOT transition status. Work item stays `draft`.
- Write log entry: `POST /api/work-items/:id/log` with `{ "summary": "Refinement session ended without producing a DispatchContract. Cause: session interrupted (token limit, timeout, or truncation). Work item remains draft." }`
- Halt. Surface to user that the item needs re-dispatch.

### Case B — Plan Gate hard-block after 2 revision cycles

The coordinator's Plan Gate (step 4) dispatches tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm, and tech-reviewer-dx in parallel. If the board returns `block` on both the original refinement plan and one revision cycle, refinement cannot proceed.

- Do NOT transition status. Work item stays `draft`.
- Write log entry: `POST /api/work-items/:id/log` with `{ "summary": "Refinement halted: Plan Gate returned block after 2 revision cycles. Work item remains draft. Review the board findings and address the blocking concerns before re-refining." }`
- Log the board's block reasons in the summary if available.
- Halt.

### Case C — Coordinator approaching maxTurns before contract is complete

Proactive agent-side early exit: the coordinator detects it is within ~10 turns of the session maxTurns limit and has not yet produced a complete DispatchContract. This is distinct from Case A — Case A is detected after the session ends; Case C is a live in-session detection that fires before the limit is reached.

- Immediately write log entry: `POST /api/work-items/:id/log` with `{ "summary": "Refinement halted: approaching maxTurns limit before DispatchContract could be completed. Work item remains draft. Consider simplifying the item description or splitting into smaller tickets before re-refining." }`
- Do NOT produce a partial contract.
- Do NOT transition status. Work item stays `draft`.
- Halt immediately.
