# Project Refinement Session

## Session Mode

Non-implementation. No code changes. No git operations. No deployment.
Permitted: ticket management, contract authoring, artifact generation and update,
planning, PM coordination, board reviews, status transitions up to `planned`, API calls, logging.

---

## Goal

Bring every active (non-terminal) work item in the target project to fully-refined
`planned` status, each carrying a complete and board-validated DispatchContract.
Items at `planned` or beyond are evaluated for contract completeness; if the contract
is missing, incomplete, or low-quality, they are re-refined.

The session is tracked in a Refinement Session File written to
`work/refinement-sessions/<session-id>.json` from the first step onward. Every
checklist step for every item is recorded there atomically so the session can be
resumed if interrupted.

---

## Step 1 — Initialize Session File

Generate a session ID: `ref-<YYYY-MM-DD-HH-mm>-<org>-<proj>-<comp>`
(e.g. `ref-2026-05-15-1430-ticari-architect-main`).

Create `work/refinement-sessions/<session-id>.json` with this exact schema:

```json
{
  "session_id": "<session-id>",
  "started_at": "<ISO8601>",
  "project": { "org": "<org>", "project": "<project>", "component": "<component>" },
  "status": "in_progress",
  "batches": [],
  "items": {},
  "summary": {
    "total": 0,
    "refined": 0,
    "input_needed": 0,
    "deferred_dependency": 0,
    "deferred_cyclic": 0,
    "evaluated_no_change": 0,
    "board_reviews_run": 0,
    "epics_updated": []
  }
}
```

Per-item entry schema (populated in Step 4, updated after every checklist step):

```json
{
  "W-XXX": {
    "title": "...",
    "initial_status": "draft",
    "classification": "full_refinement",
    "complexity": null,
    "checklist": {
      "pre_board_review":      "pending",
      "research_done":         "pending",
      "contract_drafted":      "pending",
      "contract_gate_review":  "pending",
      "post_board_review":     "pending",
      "artifact_patch_item":   "pending",
      "artifact_plan_written": "pending",
      "artifact_doc_written":  "pending",
      "artifact_board_log":    "pending",
      "artifact_log_posted":   "pending"
    },
    "board_verdicts": {
      "pre_board":     null,
      "contract_gate": null,
      "post_board":    null
    },
    "final_status": null,
    "contract_complete": false,
    "input_needed_reason": "",
    "notes": "",
    "updated_at": "<ISO8601>"
  }
}
```

Write the session file before doing anything else. Update it after every checklist
step transition. It is the source of truth for session progress — not memory.

---

## Step 2 — Load Project Context

1. Resolve target project from portfolio registry. If ambiguous, ask before proceeding.
2. Load portfolio context at standard tier:
   `$ARCHITECT_PORTFOLIO_DIR/<org>/<project>/<component>.json`
3. Load org conventions: `$ARCHITECT_PORTFOLIO_DIR/<org>/organization.json`
4. Load sync context: accepted ADRs + recent significant commits
   (`GET /api/sync/significant?project_key=<key>`)
5. Fetch all active epics and their linked item IDs
   (`GET /api/epics` filtered to project)
6. Load refinement template if present:
   `GET /api/projects/<org>/<proj>/<comp>/artifacts/refinement-template`
   Apply it as a mandatory style guide for every contract drafted in this session.
7. Identify any cross-project dependencies visible in portfolio entries.

---

## Step 3 — Fetch All Work Items

1. `GET /api/backlog` filtered to target project.
2. For every item returned, fetch in parallel:
   - Artifacts list: `GET /api/work-items/:id/artifacts`
   - Plan: `GET /api/work-items/:id/plan`
   - Doc: `GET /api/work-items/:id/doc`
   - Full item (includes session_log): `GET /api/work-items/:id`
3. In-scope statuses: `draft`, `planned`, `blocked`, `in-progress`, `in-review`,
   `testing`, `preview`.
   Exclude terminal statuses: `done`, `cancelled`, `archived`.

---

## Step 4 — Dependency Graph and Batching

1. Build a directed dependency graph from each item's `depends_on` array.
2. Detect cycles using DFS. Record any cyclic items in the session file under
   `"classification": "deferred_cyclic"`. Do not process them.
3. Compute topological order (Kahn's algorithm — roots first, then items whose
   dependencies are satisfied).
4. Within each topological layer, evaluate independence for parallel batching.
   Items are independent when ALL of the following hold:
   - No shared scope boundary
   - No data dependency between their contracts
   - No shared DB table or API endpoint schema
   - No ordering constraint between their artifacts
5. Group topological layers into named batches. Record in session file `"batches"` array:
   ```json
   { "batch_index": 0, "parallel": true, "items": ["W-XXX", "W-YYY", "W-ZZZ"] }
   ```
6. Classify each item and write initial classification to the session file before
   beginning any refinement.

| Classification         | Condition |
|------------------------|-----------|
| `full_refinement`      | status=`draft`; OR status=`planned` or `blocked` with `goal` field absent or empty |
| `improvement`          | status=`planned` or `blocked`, `goal` field present, but ≥1 required field for its complexity tier is absent, empty, or fails the quality bar |
| `evaluation_only`      | status=`in-progress`, `in-review`, `testing`, or `preview` |
| `input_needed`         | `input_needed=true` flag already set on the item (pre-existing, before this session) |
| `deferred_dependency`  | `depends_on` contains an item not yet refined in this session |
| `deferred_cyclic`      | Part of a detected dependency cycle |
| `confirmed`            | All required contract fields for stated complexity tier present at production quality |

**Discriminator rule (`full_refinement` vs `improvement`)**: classify as `full_refinement` when `goal` is absent or empty; classify as `improvement` when `goal` exists — regardless of status. `blocked` items without a goal → `full_refinement`; `blocked` items with a goal → `improvement`. Items with `evaluation_only` or `input_needed` classification take priority over this discriminator.

Contract completeness bar:

| Complexity | Required fields |
|------------|----------------|
| Trivial    | `goal` |
| Small      | goal, constraints, expected_output, failure_conditions |
| Medium     | small + success_criteria, e2e_test_criteria (≥2) |
| Large      | medium + scope_boundary, stop_conditions (≥3), e2e_test_criteria (≥3) |

Contract quality bar (beyond mere presence):
- `goal`: measurable and outcome-oriented — not "improve X" but "X endpoint returns Y within Z"
- `failure_conditions`: observable from test output — not "bad output" but "field Y missing from response"
- `e2e_test_criteria`: each entry specific enough to write an actual test case from it
- `stop_conditions`: self-enforceable by the dispatched agent without external system calls
- `scope_boundary`: aligned to layer/module boundaries, not over-broad

---

## Step 5 — Execute Refinement (Dispatch-First, Parallel Within Batch)

Process batches sequentially — batch N+1 starts only after batch N completes.
Within each batch, dispatch all independent item pipelines concurrently — one Agent
dispatch per item, all fired in the same message. Cap concurrent dispatches at **5 items
per batch**; if a batch contains more than 5 items, divide it into sub-groups of 5 and
process sub-groups sequentially within the batch.

**Batch halt threshold**: After each batch completes, count items that ended in `block`
(pre-board, contract gate, or post-board). If ≥50% of the batch's items ended in `block`,
halt the session: write `status: "halted_high_block_rate"` to the session file, surface the
blocked items and their reasons, and wait for user instruction before continuing.

**Post-batch dependency re-check**: After each batch, re-evaluate `deferred_dependency`
items to see if their blocking predecessors are now refined. Promote any unblocked items
into the next batch before dispatch.

For items classified `full_refinement` or `improvement`, run the full sub-pipeline (5a–5f).
For items classified `evaluation_only`, use the lighter path in Step 6.

---

### 5a — Pre-Refinement Board Review

**Complexity condition**: For items classified `improvement` where description length and scope clearly indicate `trivial` or `small` complexity (single file change, no cross-system impact, goal and expected_output already populated): skip 5a, record `pre_board_review: "skipped_low_complexity"` in the session file, and proceed directly to 5b. For all `full_refinement` items, and for any item where complexity is uncertain, always run the board.

Dispatch the Review Board (Plan Gate composition) against the **current state** of the item.

Provide to the board:
- Item ID, title, current status, priority, tags
- Full description and any existing contract fields
- plan.md and doc.md content (if any)
- session_log entries
- Portfolio context (standard tier) and org conventions
- Epic context if item is linked to an epic

Board composition:

| Reviewer               | Always? | Conditional trigger |
|------------------------|---------|---------------------|
| tech-reviewer-swe      | Yes     | — |
| tech-reviewer-arch     | Yes     | — |
| tech-reviewer-pm       | Yes     | — |
| tech-reviewer-frontend | No      | item scope touches UI/component code |
| tech-reviewer-ux       | No      | item introduces user flows |
| tech-reviewer-dx       | No      | item changes developer-facing API/SDK/CLI |
| tech-reviewer-dba      | No      | item touches DB schema or queries |
| tech-reviewer-systems  | No      | item crosses subsystem boundaries |
| tech-reviewer-prod     | No      | item introduces backend services, secrets, or runbooks |

Board focus: Is the current description coherent and implementable? Are dependencies
correctly declared? Is scope realistic? Are there structural problems that would
invalidate any contract written from this description?

Verdict handling:
- All `approve` → update session file `pre_board_review: "pass"`, proceed to 5b
- Any `revise` (no block) → record concerns in session file notes; incorporate into
  refinement scope; set `pre_board_review: "pass_with_concerns"`, proceed to 5b
- Any `block` → set `pre_board_review: "fail"`;
  `PATCH /api/work-items/:id` `{"input_needed": true, "input_needed_reason": "<block reason>"}`;
  log via `POST /api/work-items/:id/log`; update session file `input_needed_reason`; skip to next item

---

### 5b — Research and Enrichment

Before drafting the contract, gather:
- All items in the same epic and their current contract states
- Cross-project items this item depends on or which depend on it
  (load their portfolio entry at minimal tier). Lookup procedure: call
  `GET /api/work-items/W-XXX` to read `project_key`, split into `<org>/<project>/<component>`,
  load `$ARCHITECT_PORTFOLIO_DIR/<org>/<project>/<component>.json` at minimal tier.
  If the portfolio entry is absent (project not onboarded), record the dependency as
  unresolvable in session notes and continue — do not halt.
- ADRs from sync context that constrain this item's scope
- Recent significant commits that affect this item's scope
- Org-level conventions relevant to the item's domain (auth, data, API patterns)

Update session file: `research_done: "done"`

---

### 5c — Draft DispatchContract

Dispatch the coordinator agent in contract-drafting mode. The coordinator is **not** producing a DispatchPlan here — it is producing the DispatchContract and supporting artifacts for an existing work item. Include in the dispatch prompt:
- Explicit instruction: "Draft a DispatchContract and supporting artifacts for work item W-XXX. Do NOT produce a DispatchPlan or step-by-step implementation breakdown. Output only the sections defined below."
- Full item context (title, description, artifacts, session_log, research findings from 5b)
- Portfolio context at standard tier + org conventions
- Cross-project context (minimal tier) for any referenced external projects
- Refinement template content embedded verbatim (if present): "Apply the following refinement template as a mandatory style guide for every field you draft: `<template content>`"
- Pre-board verdict and concerns

**Split flag handling**: If the coordinator sets `input_needed=true` in the produced contract due to a proposed item split (output F), update the session file with `input_needed_reason: "<proposed split rationale>"`, record `contract_gate_review: "skipped_split"` and `post_board_review: "skipped_split"`, then skip 5d and 5e entirely and continue to the next item.

The coordinator must produce:

**A. DispatchContract** as fenced JSON under a `# DispatchContract` heading:

```json
{
  "goal": "exact success condition — measurable, outcome-oriented (1–3 sentences)",
  "constraints": "hard limits — actionable, non-contradictory (1–3 sentences)",
  "expected_output": "specific artifact or observable behavior (1–3 sentences)",
  "failure_conditions": "observable rejection criteria — not vague (1–3 sentences)",
  "scope_boundary": "files/systems NOT to touch — layer-accurate",
  "stop_conditions": [
    "condition 1 — self-enforceable without external system calls",
    "condition 2",
    "condition 3"
  ],
  "success_criteria": "user-visible definition of done (1–3 sentences)",
  "e2e_test_criteria": [
    "scenario 1 — specific enough to write an actual test case from",
    "scenario 2",
    "scenario 3"
  ]
}
```

**B. Updated description** — clear, implementation-ready, unambiguous.

**C. plan.md content** — approach, files/systems affected, testing strategy, risks,
open questions. If plan.md already exists, append a `## Refinement Update <date>` section
rather than overwriting.

**D. doc.md content** — rationale, stakeholder context, feature description. Create only
if item is user-facing or non-obvious in purpose.

**E. Complexity classification** — trivial | small | medium | large, with one-sentence
reasoning.

**F. Split flag** — if the item should be decomposed into sub-items, list the proposed
sub-items but do NOT create them without user confirmation. Set `input_needed=true` with
the proposed split as the reason, then continue to Contract Gate with the current scope.

Update session file: `contract_drafted: "done"`, `complexity: "<value>"`

---

### 5d — Contract Gate Review

Dispatch a focused Contract Gate board on the produced DispatchContract.
This gate is distinct from the Plan Gate. It evaluates the contract document only —
not the implementation approach, not architecture soundness, not code style — only
contract completeness, measurability, and self-enforceability.

Board: tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-pm (always; no additions).
Pass `"phase": "contract"` in the dispatch to distinguish from Plan Gate dispatches.

Evaluation criteria per reviewer:

**tech-reviewer-swe**: Are `e2e_test_criteria` entries specific enough to write actual
test code from? Is each criterion independently testable? Is `failure_conditions`
observable from test output without reading source code? Is the complexity classification
consistent with the stated scope?

**tech-reviewer-arch**: Is `scope_boundary` correctly aligned to layer and module
boundaries — not over-broad? Does the contract respect the inward-dependency rule?
Are `stop_conditions` self-enforceable by the dispatched agent without external
system calls or human involvement?

**tech-reviewer-pm**: Is `goal` achievable within reasonable effort for the stated
complexity? Is `success_criteria` verifiable by a non-technical stakeholder? Are
`constraints` realistic and non-contradictory? Does `expected_output` map to a
deliverable that can be demoed or shipped?

Verdict handling:
- All `approve` → update session file `contract_gate_review: "pass"`, proceed to 5e
- Any `revise` → incorporate into contract; re-dispatch coordinator for targeted fix;
  re-run Contract Gate. The initial run is cycle 0; max 2 additional revision cycles
  (cycles 1 and 2). Record cycle count in session file notes.
- Any `block` after cycle 2 (i.e., after the third run) → set `contract_gate_review: "fail"`;
  `PATCH /api/work-items/:id` `{"input_needed": true, "input_needed_reason": "<specific gap>"}`;
  log via `POST /api/work-items/:id/log`; update session file `input_needed_reason`; skip to next item

---

### 5e — Post-Refinement Board Review

Dispatch the full Review Board (Plan Gate composition, same as 5a) against the
**refined state** of the item. Provide full context:
- Before-state (description snapshot before refinement)
- After-state delta (what changed)
- Final DispatchContract
- plan.md, doc.md
- Pre-board verdict and concerns from 5a
- Contract Gate verdict from 5d
- Research findings from 5b
- Epic context if linked

Board focus: Overall refinement quality. Is this a clear, implementable unit of work?
Is the contract production-ready for a coder dispatch? Does plan.md give a coder enough
context to begin immediately without asking questions?

Verdict handling:
- All `approve` → update session file `post_board_review: "pass"`; proceed to 5f
- Any `revise` → incorporate concerns; rewrite affected contract fields or plan sections;
  re-run post-board (max 2 cycles). Re-run Contract Gate only if contract fields changed —
  defined as any of: `goal`, `constraints`, `expected_output`, `failure_conditions`,
  `scope_boundary`, `stop_conditions`, `success_criteria`, or `e2e_test_criteria` were
  modified. If only `plan.md` or `doc.md` sections were updated, skip Contract Gate re-run.
  Any Contract Gate re-run counts within the existing 2-cycle budget from 5d.
- Any `block` after 2 cycles → set `post_board_review: "fail"`;
  `PATCH /api/work-items/:id` `{"input_needed": true, "input_needed_reason": "<escalation reason>"}`;
  log escalation via `POST /api/work-items/:id/log`; update session file `input_needed_reason`;
  do not transition status; continue to next item

---

### 5f — Write Results

After post-refinement board approval, execute each write in order and record its checkpoint
immediately after success. This enables safe resume: skip any write whose checkpoint is
already `"done"`.

1. `PATCH /api/work-items/:id`
   ```json
   {
     "description": "<updated description with embedded contract>",
     "status": "planned"
   }
   ```
   Transition `draft → planned` only. Items already at `planned` or later: omit `"status"`
   field. **Validation**: read back `GET /api/work-items/:id` and confirm `status` equals
   the expected value and `updated_at` advanced. If the read-back shows no change, log
   `"PATCH silently failed — status did not transition"` and apply `input_needed` halt
   protocol with `reason: "PATCH /api/work-items/:id produced no observable state change"`.
   On success: update session file `artifact_patch_item: "done"`.

2. `PUT /api/work-items/:id/plan` — refined plan.md
   On success: update session file `artifact_plan_written: "done"`.

3. `PUT /api/work-items/:id/doc` — doc.md (if created or meaningfully updated; skip if not applicable)
   On success: update session file `artifact_doc_written: "done"`.

4. `PUT /api/work-items/:id/artifacts/board-review-<session-id>.md` — board review log:
   pre-board verdict, Contract Gate verdict, post-board verdict, all concerns raised,
   all resolutions applied, revision cycle counts per gate.
   On success: update session file `artifact_board_log: "done"`.

5. `POST /api/work-items/:id/log`
   ```json
   {
     "summary": "Refinement session <session-id>: contract established, board-approved. Complexity: <value>. Cycles — pre=<n>, contract=<n>, post=<n>."
   }
   ```
   On success: update session file `artifact_log_posted: "done"`.

6. Update session file entry:
   ```json
   {
     "final_status": "planned",
     "contract_complete": true,
     "updated_at": "<ISO8601>"
   }
   ```
   Increment `summary.refined` and `summary.board_reviews_run` (by count of gates run).

**Session file write failure**: If any session file write fails (disk error, serialization error), log the failure to stdout and attempt a single retry. If retry fails, continue processing remaining items — session file corruption is recoverable from the dashboard DB state. Do not halt the session.

---

## Step 6 — Evaluation-Only Pass (in-progress and later items)

Dispatch all evaluation-only items concurrently. Each item writes only to its own artifact
path (`PUT /api/work-items/:id/artifacts/refinement-eval-<session-id>.md`), so concurrent
dispatches cannot conflict regardless of dependency relationships.

For each item:
1. Evaluate DispatchContract completeness and quality against the same bar as Step 4.
2. Evaluate plan.md existence and coverage.
3. If contract complete and adequate: update session file `classification: "confirmed"`;
   log confirmation via `POST /api/work-items/:id/log`.
4. If contract missing or inadequate: write findings to
   `PUT /api/work-items/:id/artifacts/refinement-eval-<session-id>.md`
   (do NOT overwrite existing plan.md or description). Log finding. Update session file `notes`.
5. Do not change item status.

---

## Step 7 — Epic Pass

Collect all unique epic IDs referenced by in-scope items (deduplicate — multiple items may
link to the same epic). Dispatch one check per unique epic ID, all concurrently. For each epic:

1. `GET /api/epics/:id/plan` and `GET /api/epics/:id/doc`
2. Verify: does the epic plan reflect the refined item contracts? Are epic acceptance
   criteria consistent with what items now contractually deliver? Is epic status
   appropriate given current item statuses?
3. If epic plan is missing or inconsistent: draft/update it via `PUT /api/epics/:id/plan`.
4. Log any epic-level findings on each linked item via `POST /api/work-items/:id/log`.
5. Record updated epic IDs in session file `summary.epics_updated` array.

---

## Step 8 — Surface Input-Needed Items

Read the session file. Collect all items where `final_status = null` (any board gate
failed, split proposed, or item was pre-existing input_needed). For each item, determine
its source:
- `pre_existing` — item's `initial_classification` was `input_needed` (flag was set before this session)
- `session_block` — flag was set during this session (by 5a, 5c split, 5d, or 5e)

Group by question theme and present:

```
## Items Requiring Input

### [Theme: Contract Scope Clarification]
- W-XXX "Title" [source: session_block — contract gate cycle 2]
  Question: <input_needed_reason>
  Blocks downstream: W-YYY, W-ZZZ

### [Theme: Proposed Item Split]
- W-AAA "Title" [source: session_block — coordinator proposed split]
  Proposed sub-items: [list]
  Reason: complexity=large; single item exceeds reasonable dispatch scope.

### [Theme: Pre-existing — awaiting user answer]
- W-BBB "Title" [source: pre_existing]
  Question: <input_needed_reason from item>
```

Group by theme — do not present all questions in a flat list.

---

## Step 9 — Final Summary

Update session file: `status: "completed"`, populate full `summary` object.

Emit a `# RefinementSummary` fenced JSON block matching the canonical schema from
`domain/entities.md → RefinementSummary` (persisted to `dispatches.completion_summary`):

```json
{
  "status": "completed",
  "halt_reason": null,
  "counts": {
    "visited": 0,
    "refined": 0,
    "skipped_already_planned": 0,
    "marked_input_needed": 0,
    "errored": 0,
    "created": 0,
    "cancelled": 0,
    "archived": 0
  },
  "items": [
    { "id": "W-XXX", "before_status": "draft", "after_status": "planned", "outcome": "refined", "note": "complexity: medium" },
    { "id": "W-YYY", "before_status": "planned", "after_status": "planned", "outcome": "confirmed", "note": "contract complete" },
    { "id": "W-ZZZ", "before_status": "draft", "after_status": "draft", "outcome": "input_needed", "note": "<input_needed_reason>" }
  ],
  "epics": [
    { "id": "E-XXX", "outcome": "updated", "note": "plan updated to reflect refined item contracts" }
  ]
}
```

`outcome` values per item: `refined` | `confirmed` | `input_needed` | `deferred_dependency` | `deferred_cyclic` | `evaluation_only`.
`counts.skipped_already_planned` = items at `planned`+ that passed evaluation unchanged.
`counts.marked_input_needed` = items where `input_needed=true` was set during this session.
`halt_reason` is non-null only when `status: "halted"` (high block rate or non-bypassable pause).

The session file at `work/refinement-sessions/<session-id>.json` retains the full per-item
checklist detail, board verdicts, cycle counts, and artifact paths.

---

## Hard Constraints

- No implementation, code changes, git operations, or deployment.
- Do not transition any item past `planned` status.
- Do not create new work items without explicit user confirmation.
- Preserve pre-existing `input_needed` flags — clear only if the blocking question
  is answered within this session.
- Serialize coordinator dispatches that target the same source files (check file-overlap
  before concurrent dispatch).
- For cross-project dependencies: load the referenced project's portfolio entry at
  minimal tier and include relevant conventions in the refinement context.
- If a refinement template exists for the project, apply it as a mandatory style guide
  to every contract drafted.
- If the post-board blocks after 2 revision cycles, mark `input_needed` and continue —
  do not guess or lower the quality bar.
- Update the session file after every state transition.
