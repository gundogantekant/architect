# Domain Entities

Canonical schemas for all structured data in the architect system. Agents and skills reference this file instead of embedding schemas inline.

## Agent

```json
{
  "name": "string",
  "role": "string",
  "model": "opus|sonnet|haiku",
  "role_category": "triage|dispatch-planning|git-operations|read-only|implementation|interactive|onboarding|data-write",
  "context_tier": "none|minimal|standard|full",
  "read_only": "boolean",
  "max_turns": "number"
}
```

**Read-only agents**: reviewer, security-auditor, performance, strategist, classifier, coordinator, findings-coordinator, scout, debugger, dependency-manager, tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-dx, tech-reviewer-ux, tech-reviewer-frontend, tech-reviewer-dba, tech-reviewer-pm, tech-reviewer-systems, tech-reviewer-iot, tech-reviewer-prod
**Interactive agents**: browser (interacts with web via Playwright, no code/data writes)
**Implementation agents**: coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer, documenter, refactorer, git-ops
**Onboarding agents**: profiler (writes only CLAUDE.md to the target project)
**Data-write agents**: tracker (uses dashboard API (http://127.0.0.1:3777/api/...) for work item and epic CRUD; writes work/epics/E-XXX/*.md and work/items/W-XXX/*.md for artifacts)

See `domain/rules.md` → Model Selection Rules for the canonical default model table, and → Role-Scoped Context Injection for tier assignments.

## RequestClassification

Output by the classifier agent when triaging a request.

```json
{
  "type": "feature|bugfix|refactor|question|review|deploy|maintenance|strategic|investigation",
  "complexity": "trivial|small|medium|large",
  "confidence": "number (0.0-1.0)"
}
```

## ClassifierOutput

Full output of the classifier agent. Extends RequestClassification with dispatch hints.

```json
{
  "classification": { "$ref": "RequestClassification" },
  "suggested_workflow": "$ref WorkflowPattern",
  "needs_coordinator": "boolean (true when complexity >= medium or confidence < 0.6)",
  "suggested_agents": ["string (agent names)"]
}
```

**Rules**: When `needs_coordinator` is false, the orchestrator constructs a simple dispatch plan directly from this output. When true, the orchestrator dispatches the coordinator agent with this output as input.

## PreDispatchCheckResult

Output by the orchestrator when running pre-dispatch awareness checks. The orchestrator evaluates whether the user's request overlaps with recent commits, done/in-progress work items, or active dispatches before proceeding with agent dispatch.

```json
{
  "status": "clear|warning|conflict",
  "findings": [
    {
      "type": "already_done|partial_overlap|active_conflict|stale_context",
      "severity": "minor|major|critical",
      "evidence": "string — commit hash, work item ID, or file path",
      "summary": "string — what was found",
      "recommendation": "string — suggested action"
    }
  ]
}
```

Status semantics:
- `clear` — no findings, proceed silently without mentioning the check
- `warning` — findings exist (minor/major severity), present to user before proceeding
- `conflict` — at least one critical finding, strongly recommend user review before proceeding

Severity alignment (matches TechReviewVerdict severity scale):
- `minor` — related activity detected (1 keyword match), informational only
- `major` — likely overlap, user should confirm awareness (2+ keyword matches)
- `critical` — strong evidence request is already addressed (exact title match on done item)

Finding type semantics:
- `already_done` — a done work item or recent commit closely matches the request
- `partial_overlap` — request scope overlaps with an existing done/in-progress item's scope
- `active_conflict` — an in-progress item or active dispatch targets the same area
- `stale_context` — recent commits modified files/modules the request targets

**Trigger**: The orchestrator runs this check when the classifier returns `type` in {feature, bugfix, refactor, maintenance} AND `complexity` >= small. No classifier schema change is needed — the orchestrator derives the trigger from existing ClassifierOutput fields. See `domain/rules.md` → Pre-Dispatch Check Rules.

## SessionIdentity

Metadata describing the identity and scope of a session. Every dispatched agent session carries a SessionIdentity that determines what actions it may perform. The orchestrator (main session) and CLI sessions operate at depth 0 with full scope; dashboard-dispatched agents operate at depth 1 with restricted scope.

```json
{
  "session_type": "orchestrator|dispatch|terminal|cli",
  "session_id": "string (D-xxx, T-xxx, C-xxx, or 'main')",
  "parent_session_id": "string | null (null for main orchestrator and CLI sessions)",
  "dispatch_depth": "number (0 = main/cli, 1 = dashboard-dispatched, 2+ = forbidden)",
  "context_tier": "none|minimal|standard|full"
}
```

Session type semantics:
- `orchestrator` — the main Claude session acting as PM/orchestrator. Depth 0.
- `dispatch` — a Claude agent spawned by the dashboard for a work item. Depth 1.
- `terminal` — an interactive PTY session spawned by the dashboard. Depth 1.
- `cli` — an external CLI session registered via the dashboard API. Depth 0.

See `domain/rules.md` → Session Scope Rules for permission tiers per session type.

## WorkflowPattern

```
"sequential|parallel-fan-out|plan-then-execute|investigate-then-fix|strategic-evaluation|direct"
```

## DispatchPlan

Full coordinator output. References RequestClassification and WorkflowPattern.

```json
{
  "target_project": {
    "organization": "string — org from portfolio, or '–' if not onboarded",
    "project": "string — project from portfolio, or directory basename",
    "component": "string — component from portfolio, or '–' if single-component",
    "path": "string — absolute filesystem path",
    "branch": "string — branch name, append ', worktree' if applicable"
  },
  "classification": { "$ref": "RequestClassification" },
  "clarifications_needed": ["string"],
  "execution_plan": {
    "workflow": "$ref WorkflowPattern",
    "worktree_required": "boolean (true when any step uses an Implementation agent)",
    "steps": [
      {
        "order": "number",
        "agent": "string (agent name)",
        "purpose": "string",
        "parallel_with": ["string (agent names)"],
        "contract": { "$ref": "DispatchContract (required for medium+ complexity, optional for trivial/small)" }
      }
    ]
  },
  "skip_reason": "string (only if no agents needed)",
  "suggested_work_item": {
    "title": "string",
    "priority": "medium|high|critical",
    "tags": ["string"],
    "reason": "string"
  }
}
```

**Rules**: `suggested_work_item` only for medium+ complexity. `skip_reason` mutually exclusive with `execution_plan.steps`. `contract` is required on all steps when classification complexity is `medium` or `large`; optional for `trivial` and `small`. When present, `purpose` serves as a one-line summary; `contract` provides the full success criteria. Steps without `contract` (legacy or trivial) remain valid.

## DispatchContract (Value Object)

Defines the success criteria for a single dispatch step. Immutable, compared by value, no identity or lifecycle. Embedded in DispatchPlan steps — not stored independently.

```json
{
  "goal": "string — the exact success condition; what must be true when complete (1-3 sentences)",
  "constraints": "string — hard boundaries that must not be crossed (1-3 sentences)",
  "expected_output": "string — the specific artifact or structure the agent must produce (1-3 sentences)",
  "failure_conditions": "string — what makes the output unacceptable (1-3 sentences)",
  "scope_boundary": "string | null — files/directories the agent must NOT modify; null for trivial/small",
  "stop_conditions": "string[] | null — conditions requiring the agent to halt and report; null for trivial/small",
  "success_criteria": "string | null — user-visible conditions defining done (1–3 sentences); required for medium+, null for trivial/small",
  "e2e_test_criteria": "string[] | null — specific E2E test scenarios the agent must implement; required for medium+ (3+ for large), null for trivial/small"
}
```

**Rules**: All four core fields (goal, constraints, expected_output, failure_conditions) are required when the contract is present. `scope_boundary` is required for large complexity, optional for medium, absent for trivial/small. `stop_conditions` is required for large complexity (3+ conditions), optional for medium, absent for trivial/small. `success_criteria` is required for medium+, null for trivial/small. `e2e_test_criteria` is required for medium+ (3+ entries for large), null for trivial/small. Each string field should be 1–3 sentences. Empty strings are treated as absent (see `domain/rules.md` → Dispatch Contract Rules). The coordinator produces contracts as part of the DispatchPlan; the prompt-builder renders them in the dispatch prompt.

## ScoutReport

Output by scout when scanning a project.

```json
{
  "language": "dart|typescript|python|go|rust",
  "framework": "flutter|react|nestjs|fastapi|nextjs|express",
  "mobile": "flutter|expo|react-native|none",
  "ci": "github-actions|forgejo|none",
  "containers": "docker|podman|none",
  "database": "postgresql|sqlite|mongodb|firestore|none",
  "testing": "jest|vitest|pytest|flutter-test|maestro",
  "package_manager": "npm|yarn|pnpm|bun|pub|pip|cargo",
  "conventions": {
    "branch_prefix": "string",
    "pr_title": "string"
  },
  "structure_notes": "string"
}
```

## ProjectBrief

Output by profiler when analyzing a project's purpose, architecture, and constraints.

```json
{
  "purpose": "string — one sentence: what the system does",
  "domain": "string — business/product domain (e.g., medical-device-control, e-commerce)",
  "users": "string — who uses the system and how",
  "key_entities": ["string — core domain objects (3-8 items)"],
  "data_flow": "string — high-level data movement description",
  "architecture_rationale": "string — why the stack and design were chosen",
  "constraints": ["string — hard non-negotiables"],
  "environments": ["string — deployment targets with provider/region"],
  "external_dependencies": ["string — third-party services"],
  "profiled_at": "YYYY-MM-DD"
}
```

## DocumentationMap

Relative paths to documentation files found in the target project. Stored as part of the PortfolioEntry so agents know where to find detailed docs on demand.

```json
{
  "doc_paths": ["string — relative paths to documentation files in the target project"]
}
```

## PortfolioEntry (Component Profile)

Stored at `portfolio/<org>/<project>/<component>.json`.

```json
{
  "name": "string",
  "path": "string (absolute path)",
  "role": "mobile-frontend|backend|firmware|desktop|library|fullstack",
  "onboarded_at": "YYYY-MM-DD",
  "last_scanned": "YYYY-MM-DD",
  "scout_report": { "$ref": "ScoutReport" },
  "brief": { "$ref": "ProjectBrief" },
  "doc_paths": ["string — relative paths like README.md, docs/architecture.md, CONTRIBUTING.md"],
  "agents": {
    "recommended": ["string (agent names)"],
    "dispatch_notes": { "agent-name": "string (usage note)" }
  },
  "guidance": {
    "stack_summary": "string",
    "structure": ["string (path: description)"],
    "conventions": ["string"],
    "ci_cd": ["string"],
    "testing": ["string"]
  },
  "custom_rules": ["string"],
  "portfolio_guides": ["string — filenames of markdown guides in the same portfolio directory to auto-load"],
  // portfolio_guides: must include at minimum "local-dev-setup.md" for any project where setup complexity
  // was detected at onboarding. Auto-generated skeleton at onboarding; overwritten on /onboard rescan.
  "worktree_mode": "auto|explicit|none (default: auto — 'auto' creates worktrees by default, 'explicit' only when user explicitly requests, 'none' for non-git projects — no worktrees ever created, dispatch works in-place)",
  // worktree_mode: must always be set explicitly. When "explicit" is chosen, a rationale entry in
  // custom_rules is required per domain/rules.md → Worktree Rules. "none" is set automatically by
  // the profiler when the project has no git repository. "none" ≠ "explicit": explicit still allows
  // on-request worktrees; none means the project cannot support worktrees at all.
  "worktree_setup": {
    "copy_paths": ["string — relative paths to copy from source to worktree"],
    // copy_paths: populated by the profiler via git ls-files --others --ignored --exclude-standard.
    // An empty array [] is valid and explicit — it means no gitignored runtime files were detected.
    // An ABSENT worktree_setup field (not present at all) means the project was onboarded before
    // detection was added — triggers the Pre-Dispatch Worktree Readiness Check warning.
    "post_commands": ["string — shell commands to run in worktree after copy"]
  },
  "interfaces": {
    "provides": [
      {
        "name": "string (e.g., 'REST API v2', 'BLE Protocol Service')",
        "protocol": "rest|grpc|graphql|event|ble|shared-lib",
        "description": "string"
      }
    ],
    "consumes": [
      {
        "name": "string",
        "provider_project": "string (org/project/component)",
        "protocol": "rest|grpc|graphql|event|ble|shared-lib"
      }
    ]
  }
}
```

**Optional fields**: `brief`, `doc_paths`, `portfolio_guides`, `worktree_mode`, `worktree_setup`, and `interfaces` are absent on entries onboarded before the profiler was added or where no setup is needed. After onboarding with profiler Phase 5.5, `worktree_setup` is always present (either with `copy_paths` populated or explicitly `{"copy_paths": [], "post_commands": []}`). An absent `worktree_setup` field is a signal that the project needs rescanning. The `interfaces` field enables cross-project awareness — the orchestrator and coordinator use `consumes` to identify impact when planning changes that affect APIs or protocols.

## Organization

Stored at `portfolio/<org>/organization.json`.

```json
{
  "name": "string",
  "path_root": "string (absolute path)",
  "conventions": {
    "branch_prefix": "string",
    "pr_title_pattern": "string"
  },
  "rules": ["string"],
  "coding_standards": {
    "additional_rules": ["string — org-specific coding rules beyond the system defaults"],
    "framework_patterns": {
      "<framework-name>": ["string — framework-specific patterns or conventions"]
    }
  },
  "projects": ["string"],
  "design_systems": {
    "<system-key>": {
      "type": "figma|sketch|abstract",
      "url": "string",
      "description": "string",
      "depends_on": ["string (project names)"]
    }
  }
}
```

**Optional fields**: `coding_standards`, `design_systems`, `cloud_environments`.

## WorkItem

Stored in PostgreSQL (`work_items` table). The project key (`org/project/component`) provides the project context, so items do not carry a redundant `project` field.

```json
{
  "id": "string (W-XXX format, zero-padded)",
  "title": "string",
  "status": "draft|planned|in-progress|blocked|in-review|testing|preview|done|cancelled|archived",
  "priority": "low|medium|high|critical",
  "description": "string",
  "epic_id": "string (E-XXX or empty, optional)",
  "project_key": "string (org/project/component) — derived from storage location, included in API responses",
  "created_at": "string (ISO 8601)",
  "updated_at": "string (ISO 8601)",
  "depends_on": ["string (W-XXX)"],
  "tags": ["string"],
  "input_needed": "boolean — flag, blocks forward transitions while active",
  "input_needed_from": "string — who needs to provide input (optional)",
  "input_needed_reason": "string — what information is needed (optional)",
  "input_needed_at": "string (ISO 8601) — when flagged (optional)",
  "approval": {
    "active": "boolean — flag, blocks forward transitions while active",
    "mode": "all|any|sequential — resolution mode",
    "requested_at": "string (ISO 8601, optional)",
    "resolved_at": "string (ISO 8601, optional)",
    "approvers": [ { "$ref": "WorkItemApproval" } ]
  },
  "released_at": "string (ISO 8601, optional) — when shipped; only settable when status=done",
  "released_version": "string — version identifier (optional)",
  "session_log": [
    { "date": "string (ISO 8601)", "summary": "string" }
  ]
}
```

### State semantics (10 values)

| Phase | Status | Description |
|-------|--------|-------------|
| Refinement | `draft` | Rough idea, no contract yet |
| Planning | `planned` | Contract validated; dashboard dispatch allowed from here |
| Implementation | `in-progress` | Actively being worked on |
| | `blocked` | Blocked by dependency or external factor |
| Validation | `in-review` | Code complete, under technical review (code gate) |
| | `testing` | Review passed, tests in progress |
| Acceptance | `preview` | Stakeholder acceptance testing |
| Terminal | `done` | Completed |
| | `cancelled` | Abandoned; soft-deleted items land here |
| | `archived` | Hidden from active backlog |

### Work Item Artifact Directory

Work item artifacts (plans, documentation) are stored as files at `work/items/W-XXX/`:
- `plan.md` — implementation plan
- `docs.md` — documentation and notes

Directories are created lazily on first write. The `notes` field on WorkItem is **deprecated** — existing content is migrated to `work/items/W-XXX/docs.md` by the v4→v5 migration.

## WorkItemApproval

Stored in PostgreSQL (`work_item_approvals` table). Normalized approver records supporting sequential ordering and cross-project blocking dependencies.

```json
{
  "id": "number (autoincrement)",
  "work_item_id": "string (W-XXX) — parent reference",
  "identity": "string — approver identifier (user, team, or role)",
  "status": "pending|approved|rejected",
  "sort_order": "number — sequence in sequential mode; ignored in all/any",
  "blocking_work_item_id": "string (W-XXX, optional) — cross-project block; approval cannot advance until blocker reaches status=done",
  "decided_at": "string (ISO 8601, optional)",
  "reason": "string (optional) — rejection reason or approval note",
  "created_at": "string (ISO 8601)"
}
```

Resolution semantics (per parent WorkItem's `approval.mode`):
- `all` — every approver must approve; any rejection flips rejected, flag stays active
- `any` — at least one approval resolves the flag
- `sequential` — only the lowest `sort_order` pending approver is active at a time; next approver is activated on approval

Maximum 20 approvers per work item (enforced at API layer).

## WorkItemLite

Lightweight projection of WorkItem used in search results. Excludes approval sub-query fields and state-machine flags. Returned by `GET /api/work-items/search`.

Fields: `id`, `title`, `status`, `priority`, `description`, `project_key`, `epic_id`, `tags`, `depends_on`, `created_at`, `updated_at`.

## WorkItemSearchResult

Response type for `GET /api/work-items/search`.

```json
{
  "items": [{ "$ref": "WorkItemLite" }],
  "query": {
    "keywords": ["string"],
    "total": "number — total matching items before 20-item cap",
    "has_more": "boolean — true when total > 20"
  }
}
```

## Epic

Top-level entity in `work/backlog.json` under the `epics` array. Epics group work items across projects into strategic goals.

```json
{
  "id": "string (E-XXX format, zero-padded)",
  "title": "string",
  "status": "draft|active|done|cancelled|archived",
  "priority": "low|medium|high|critical",
  "description": "string",
  "acceptance_criteria": "string (markdown, optional)",
  "target_date": "YYYY-MM-DD (optional, empty string if unset)",
  "project_keys": ["string (org/project/component) — derived via SQL query from linked items, not stored as array"],
  "work_item_ids": ["string (W-XXX) — derived via SQL query, not stored as array"],
  "tags": ["string"],
  "created_at": "string (ISO 8601)",
  "updated_at": "string (ISO 8601)",
  "session_log": [
    { "date": "string (ISO 8601)", "summary": "string" }
  ]
}
```

Status semantics:
- `draft` — planning phase, no work started
- `active` — at least one linked item is open/in-progress
- `done` — all linked items done (or manually closed)
- `cancelled` — abandoned
- `archived` — completed or cancelled and hidden from active views; preserves all links

## WorkBacklog

Backed by PostgreSQL (Docker, `tools/dashboard/docker-compose.yml`). Migrations run automatically on startup. The API returns this shape:

```json
{
  "next_id": "number",
  "next_epic_id": "number",
  "epics": [{ "$ref": "Epic" }],
  "projects": {
    "org/project/component": {
      "items": [{ "$ref": "WorkItem" }]
    }
  }
}
```

## WorktreeContext

Tracks an active worktree created for implementation isolation.

```json
{
  "worktree_path": "string (absolute path to worktree)",
  "source_path": "string (absolute path to original project)",
  "branch_name": "string",
  "ticket_id": "string (Notion ticket ID, e.g. GEN-1641)",
  "originating_branch": "string (branch HEAD was on when worktree was created, e.g. main, feature/org-level-dispatch)"
}
```

## AgentPhase

Ephemeral (in-memory only, not persisted to PostgreSQL) state derived from stream-json events during a dispatch session's lifetime. Tracks what the dispatched agent is currently doing. Reset to null when the dispatch reaches a terminal status.

Values:
- `worktree_setup` — dispatch infrastructure is creating and provisioning the worktree before agent spawn
- `generating` — agent is producing text (thinking, planning, responding)
- `tool_running` — agent dispatched a tool call, execution in progress
- `waiting_for_input` — agent finished its turn (stop_reason=end_turn), waiting for user
- `null` — dispatch in terminal state (completed/failed/killed/interrupted) or phase unknown

## DispatchRequest

Record created when the dashboard dispatches a Claude agent for a work item. Persisted to PostgreSQL `dispatches` table (excluding process handles and listeners). Output streamed to `work/logs/D-xxx.jsonl`. On restart, sessions with live PIDs are reconnected via log file tailing; others are marked `interrupted`.

```json
{
  "id": "string (D-<timestamp>)",
  "work_item_id": "string (W-XXX)",
  "epic_id": "string (E-XXX or empty, optional)",
  "project_key": "string (org/project/component)",
  "project_path": "string (absolute path)",
  "additional_instructions": "string (optional)",
  "permission_mode": "string (plan|acceptEdits)",
  "skip_permissions": "boolean (default false, adds --dangerously-skip-permissions flag)",
  "status": "running|completed|failed|killed|interrupted|suspended|merge_pending|merge_conflict|dismissed|superseded",
  "started_at": "string (ISO 8601)",
  "completed_at": "string (ISO 8601, optional)",
  "session_id": "string (Claude session ID, optional — legacy field)",
  "claude_session_id": "string (Claude CLI session UUID, optional — captured from stream-json init event, used for resume)",
  "cost_usd": "number (total cost, optional)",
  "pid": "number (OS process ID, optional — stored for restart survival)",
  "exit_type": "'graceful'|'killed'|'interrupted'|'unknown'|null — how the process exited. Set by close handler: 'graceful' for code 0, 'killed' for intentional kill, 'interrupted' for ungraceful termination (crash, SIGKILL, OOM). null for dispatches that were never classified (pre-W-1139 rows).",
  "agent_phase": "AgentPhase (ephemeral, in-memory only — not persisted to PostgreSQL, derived from live stream-json event parsing or log replay)",
  "worktree_path": "string (absolute path to worktree, null if no worktree — persisted to PostgreSQL)",
  "worktree_branch": "string (worktree branch name, null if no worktree — persisted to PostgreSQL)",
  "source_branch": "string (originating branch the worktree was created from, null if no worktree — persisted to PostgreSQL)",
  "dispatch_mode": "string ('standard' | 'auto_implement', default 'standard')",
  "completion_sha": "string (SHA of the final implementation commit, optional)",
  "completion_summary": "string (agent-provided summary, max 500 chars, optional)",
  "merge_result": "'success'|'conflict'|'aborted' — outcome of the merge attempt, optional",
  "plan_gate_passed": "boolean | null     // null until plan gate runs; true if approved, false if blocked",
  "plan_gate_passed_at": "string | null   // ISO 8601 timestamp when plan gate resolved; null until then",
  "code_gate_passed": "boolean | null     // null until code gate runs; true if approved, false if blocked",
  "code_gate_passed_at": "string | null   // ISO 8601 timestamp when code gate resolved; null until then",
  "contract_satisfied": "boolean | null   // null until code gate; set true when all e2e_test_criteria confirmed passing",
  "contract_satisfied_at": "string | null // ISO 8601 timestamp when contract satisfaction was confirmed"
}
```

Status semantics for terminal states:
- `dismissed` — user acknowledged an interrupted session and dismissed the recovery banner. Not shown in recovery surface.
- `superseded` — session was replaced by a re-dispatch. Treated same as dismissed in UI.

CompleteDispatchRequest validation:
- For medium+ complexity dispatches: reject completion if code_gate_passed !== true
- For trivial/small dispatches: gate fields may be null (backward compatible; no rejection)
- Complexity is determined by getComplexityLevel(workItem) — see Isolated Work Mandate

## AutonomousCompletionPayload (Value Object)

Request body sent by the agent to POST /api/dispatch/:id/complete to signal that autonomous pipeline execution has completed. Immutable, no identity or lifecycle.

```json
{
  "sha": "string — git commit SHA of the final implementation commit",
  "summary": "string — brief one-line agent-provided summary (max 500 chars)"
}
```

Rules: Both fields are required. sha must be a valid git SHA string. summary is informational only. This endpoint is agent-only — callers must supply X-Architect-Session-Depth: 1 header. See domain/rules.md → Autonomous Pipeline Rules.

## TerminalSession

Record for an interactive PTY terminal session spawned from the dashboard. Persisted to PostgreSQL `terminals` table (excluding ptyProcess, scrollback, wsClients). When tmux is available, terminals are wrapped in tmux sessions for restart survival. On restart, tmux sessions are re-attached; PID-only sessions are marked as detached; dead sessions are marked `interrupted`.

```json
{
  "id": "string (T-<timestamp>)",
  "work_item_id": "string (W-XXX or null)",
  "epic_id": "string (E-XXX or null, optional)",
  "project_key": "string (org/project/component)",
  "project_path": "string (absolute path)",
  "title": "string",
  "permission_mode": "string (plan|acceptEdits)",
  "skip_permissions": "boolean (default false, adds --dangerously-skip-permissions flag)",
  "status": "running|completed|failed|killed|interrupted|suspended",
  "started_at": "string (ISO 8601)",
  "exited_at": "string (ISO 8601, null while running)",
  "pid": "number (OS process ID, optional — stored for restart survival)",
  "tmux_session": "string (tmux session name, optional — e.g. architect-T-xxx)",
  "claude_session_id": "string (Claude CLI session UUID — required for suspend/resume; only present when agent_type === 'claude'. Suspend is rejected if absent or if agent_type !== 'claude')"
}
```

## CliSession

Record for a CLI session registered externally via the dashboard API. Read-only from the dashboard's perspective — no kill, no output streaming. PID liveness is checked periodically to detect exit.

```json
{
  "id": "string (C-<timestamp>)",
  "project_key": "string (org/project/component)",
  "work_item_id": "string (W-XXX or null)",
  "epic_id": "string (E-XXX or null)",
  "title": "string",
  "pid": "number (OS process ID)",
  "status": "running|exited",
  "registered_at": "string (ISO 8601)",
  "exited_at": "string (ISO 8601, null while running)"
}
```

## SessionsFile

Sessions are persisted in PostgreSQL tables (`dispatches`, `terminals`, `cli_sessions`). Dispatch output is logged to `work/logs/D-xxx.jsonl` files. On startup, sessions with live PIDs (or tmux sessions) are reconnected; legacy sessions without PIDs are marked `interrupted`. The API returns this shape:

```json
{
  "dispatches": {
    "D-xxx": { "$ref": "DispatchRequest (subset: id, work_item_id, epic_id, project_key, project_path, title, status, started_at, completed_at, session_id, cost_usd, permission_mode, skip_permissions)" }
  },
  "terminals": {
    "T-xxx": { "$ref": "TerminalSession (subset: id, work_item_id, epic_id, project_key, project_path, title, status, started_at, exited_at, permission_mode, skip_permissions)" }
  },
  "cli_sessions": {
    "C-xxx": { "$ref": "CliSession" }
  }
}
```

## EscalationLogEntry

Structured log entry recorded when the orchestrator detects a condition requiring attention. Uses the canonical format for all escalation-type session log entries, ensuring consistent data across agents and views.

```json
{
  "type": "escalation",
  "trigger": "stale|blocked-chain|epic-stall|cost-anomaly|dispatch-loop|portfolio-drift",
  "summary": "string — human-readable description of the escalation",
  "related_items": ["string (W-XXX or E-XXX IDs)"]
}
```

Trigger semantics:
- `stale` — work item has had no status change or session log entry for 7+ days
- `blocked-chain` — a blocked item's blocker has no active dispatch or progress
- `epic-stall` — no linked item status change in the last 3 dispatches for an active epic
- `cost-anomaly` — a single dispatch cost exceeds 2x the project's average dispatch cost
- `dispatch-loop` — a work item has been dispatched 3+ times without reaching done

See `domain/rules.md` → Project Manager Behavior Rules → Escalation Triggers for detection criteria.

## ArchitecturalDecisionRecord

A typed record of a single architectural decision. Covers decisions made by the human, by the AI architect, or by a dispatched agent (strategist, tech-reviewer-arch). Stored as `portfolio/<org>/<project>/adrs/ADR-NNN.json`, scoped per component.

```json
{
  "id": "string — ADR-NNN format, zero-padded, scoped per component (e.g. ADR-001)",
  "title": "string — concise decision title",
  "status": "proposed | accepted | deprecated | superseded",
  "context": "string — what problem or situation prompted this decision (1-4 sentences)",
  "decision": "string — what was decided and why (1-4 sentences)",
  "consequences": "string — what changes as a result; trade-offs accepted (1-4 sentences)",
  "date": "YYYY-MM-DD — date the decision was made or recorded",
  "tags": ["string — topic tags for filtering (e.g. 'storage', 'agents', 'dispatch')"],
  "project_key": "string — org/project/component — the component this decision governs",
  "author": "string — 'architect' | 'human' | 'agent:<agent-name>' — who produced the decision",
  "source_work_item": "string (W-XXX, optional) — work item that triggered this decision",
  "superseded_by": "string (ADR-NNN, optional) — ID of the ADR that replaces this one; null unless status=superseded"
}
```

Status semantics:
- `proposed` — drafted but not yet confirmed; NOT injected into agent context
- `accepted` — confirmed and active; injected into standard/full tier agent context
- `deprecated` — still applies but discouraged
- `superseded` — replaced by another ADR (set `superseded_by` to the new ID)

ADRs are indexed in the portfolio component entry via a new optional `adrs` field (array of accepted ADR-NNN IDs). The `adrs/` directory lives alongside the component JSON: `portfolio/<org>/<project>/adrs/`.

## SyncRecord

One row per completed sync run per project in the `knowledge_syncs` PostgreSQL table. Records when a portfolio project's git history was last scanned for external changes.

```json
{
  "id": "number (autoincrement)",
  "project_key": "string (org/project/component)",
  "trigger": "session_start | scheduled | manual",
  "sync_source": "'local' | 'remote' — 'local' for /sync skill runs, 'remote' for scheduled pulls",
  "status": "pending | running | completed | failed | skipped",
  "started_at": "string (ISO 8601)",
  "synced_at": "string (ISO 8601) | null — null until completed",
  "commit_from": "string (git SHA) | null — HEAD at previous sync (the 'since' anchor)",
  "commit_to": "string (git SHA) | null — HEAD at this sync completion",
  "commits_scanned": "number",
  "significant_count": "number — count of architectural + dependency classified commits",
  "summary_json": "string (JSON) — array of SyncCommitEntry",
  "error": "string | null — failure reason when status=failed"
}
```

### SyncCommitEntry (embedded in summary_json)

```json
{
  "sha": "string — short git hash (8 chars)",
  "message": "string — first line of commit message",
  "author": "string",
  "timestamp": "string (ISO 8601)",
  "significance": "high | medium | low",
  "files_touched": ["string — relative file paths"],
  "adr_candidate": "boolean — true when commit looks like an architectural decision",
  "adr_candidate_reason": "string | null"
}
```

Freshness is computed at read time, not stored:
- `fresh` — `synced_at` within 6 hours
- `aging` — `synced_at` 6–24 hours ago
- `stale` — `synced_at` older than 24 hours, or never synced

## ChangeLogEntry

One row per significant commit detected during portfolio sync, stored in the `change_log_entries` PostgreSQL table. Forms the observable change history for a managed project between sync cycles.

```json
{
  "id": "number (autoincrement)",
  "project_key": "string (org/project/component)",
  "commit_hash": "string — full SHA-1 git commit hash",
  "commit_message": "string — first line of commit message",
  "author": "string — git author name",
  "committed_at": "string (ISO 8601)",
  "affected_files": "string (JSON array) — relative file paths changed in this commit",
  "classification": "architectural | dependency | feature | fix | docs | test | chore",
  "ai_summary": "string | null — one-sentence plain-English summary; populated for architectural/dependency commits",
  "detected_at": "string (ISO 8601) — when this entry was inserted by the sync process"
}
```

Classification semantics:
- `architectural` — touches domain layer, schema files, API definitions, root config manifests
- `dependency` — package manifest changes that add/remove/upgrade dependencies
- `feature` — new functionality (feat: prefix or additive keywords)
- `fix` — bug fixes (fix: prefix or fix/patch/resolve keywords)
- `docs` — documentation-only changes
- `test` — test file changes only
- `chore` — build, CI, formatting, everything else

Retention: entries older than 90 days are pruned on each sync run. If a project accumulates more than 100 entries after pruning, the oldest beyond 100 are also removed.

See `domain/rules.md` → Sync Rules for classification heuristics and injection limits.

## RepoSyncConfig

One row per GitHub repository participating in scheduled remote syncs. Stored in the `repo_sync_configs` PostgreSQL table.

```json
{
  "github_repo_name": "string (PK) — GitHub repository name (without org prefix)",
  "github_org": "string — GitHub organisation; defaults to 'NeuronicPBM'",
  "default_branch": "string — branch to fetch and mirror; defaults to 'main'",
  "local_path": "string | null — absolute path to work/mirrors/<name>; null until first clone",
  "portfolio_key": "string | null — org/project/component if registered in portfolio; null otherwise",
  "sync_enabled": "boolean — whether this repo participates in scheduled syncs",
  "last_github_updated_at": "string (TIMESTAMPTZ) | null — last push time from GitHub API",
  "created_at": "string (TIMESTAMPTZ)",
  "updated_at": "string (TIMESTAMPTZ)"
}
```

## OrgActivitySummary

Not persisted to the database — written as a file artifact to `~/.architect/portfolio/neuronic/sync-log.md` (appended) after each scheduled sync pass that produced new commits.

```json
{
  "generated_at": "string (ISO 8601) — timestamp of summary generation",
  "sync_run_id": "string — identifies the triggering sync pass",
  "repos_synced": ["string — github_repo_name values for repos that had new commits"],
  "technical_changelog": "string (Markdown) — org-wide narrative of changes",
  "developer_activity": "string (Markdown table) — columns: Developer | Repos | Summary",
  "repository_summaries": "string (Markdown) — one subsection per repo with commit highlights",
  "adr_candidates": [{ "$ref": "AdrCandidate" }]
}
```

### AdrCandidate (embedded in OrgActivitySummary)

```json
{
  "id": "string — ADR-YYYYMMDD-NNN format",
  "org_key": "string — organisation identifier",
  "title": "string",
  "type": "'architectural' | 'dependency' | 'feature' | 'api-contract'",
  "repos": ["string — github_repo_name values for repos that surfaced this candidate"],
  "sync_run_id": "string | null",
  "detail_path": "string — absolute path to portfolio/neuronic/adrs/<id>.md",
  "created_at": "string (TIMESTAMPTZ)"
}
```

## DashboardPreferences

Key-value pairs stored in the `preferences` table in PostgreSQL. Used for dashboard-wide settings.

```json
{
  "default_permission_mode": "plan|acceptEdits",
  "default_skip_permissions": "true|false",
  "merge_gate": "'confirm'|'auto' (default: 'confirm') — pre-merge gate mode for auto-implement dispatches; confirm=human approves in UI, auto=merge after 10s delay"
}
```

Accessed via `GET/PUT /api/settings/preferences`.

## TechReviewVerdict

Output by each tech reviewer agent when evaluating a plan, code change, or pull request.

```json
{
  "agent": "string — reviewer agent name (tech-reviewer-swe|tech-reviewer-arch|tech-reviewer-dx|tech-reviewer-ux|tech-reviewer-frontend|tech-reviewer-dba|tech-reviewer-pm|tech-reviewer-systems|tech-reviewer-iot|tech-reviewer-prod)",
  "artifact_type": "plan|diff|pr",
  "verdict": "approve|revise|block",
  "concerns": [
    {
      "severity": "critical|major|minor",
      "area": "string — which part of the artifact",
      "issue": "string — what's wrong",
      "suggestion": "string — proposed fix"
    }
  ],
  "positive_notes": ["string — what's done well"],
  "summary": "string — one-paragraph assessment"
}
```

Verdict semantics:
- `approve` — artifact is sound from this reviewer's perspective
- `revise` — artifact has issues that should be addressed but are not blocking
- `block` — artifact has fundamental problems that must be resolved before proceeding

## TechReviewBoardResult

Aggregate output of all dispatched tech reviewer agents, produced by the orchestrator. The number of reviewers varies (3–10) based on context-based board composition rules in `domain/rules.md`.

```json
{
  "verdicts": [{ "$ref": "TechReviewVerdict" }],
  "aggregate_decision": "approve|revise|block",
  "revision_cycle": "number (0-2)",
  "dispatched_agents": ["string — names of agents actually dispatched"],
  "skipped_agents": [
    {
      "agent": "string — agent name",
      "reason": "string — why not dispatched"
    }
  ]
}
```

Aggregation rules:
- Any `block` → aggregate is `block`
- Any `revise` (no `block`) → aggregate is `revise`
- All `approve` → aggregate is `approve`

## DispatchCost

Per-token cost record for a completed dispatch. Stored in the `dispatch_costs` table. One row per dispatch that emitted a result event with usage data.

```json
{
  "id": "string — dispatch ID (FK → DispatchRequest.id)",
  "model": "string — model ID (e.g. claude-sonnet-4-6)",
  "agent_role": "string — agent role (e.g. coder, planner)",
  "input_tokens": "int",
  "output_tokens": "int",
  "cache_read_tokens": "int",
  "cache_write_tokens": "int",
  "cost_usd_breakdown": "float — computed from model_pricing at insert time",
  "recorded_at": "string — ISO timestamp"
}
```

Attribution hierarchy: dispatch → work item → project → epic.

## ModelPricing

Pricing table for known Claude model IDs. Updated in-place via SQL; server restart picks up new prices.

```json
{
  "model_id": "string PK — e.g. claude-sonnet-4-6",
  "input_cost_per_mtok": "float — USD per million input tokens",
  "output_cost_per_mtok": "float — USD per million output tokens",
  "cache_read_cost_per_mtok": "float — USD per million cache-read tokens",
  "cache_write_cost_per_mtok": "float — USD per million cache-write tokens",
  "updated_at": "string — ISO timestamp"
}
```

Seeded models: `claude-opus-4-7`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.

## PromptRecord

Stored in PostgreSQL (`dispatch_prompts` table). Captures the full assembled prompt text immediately before a Claude process is spawned, enabling audit and replay.

```json
{
  "id": "number (serial PK)",
  "dispatch_id": "string | null (FK → DispatchRequest.id ON DELETE SET NULL — row survives dispatch deletion)",
  "work_item_id": "string | null",
  "project_key": "string | null",
  "prompt_text": "string (capped at 1MB)",
  "char_count": "number",
  "truncated": "boolean",
  "created_at": "string (ISO 8601)"
}
```

Capture rules:
- Inserted immediately before the spawn call at each of the three spawn sites (onboard, standard, auto-implement).
- `prompt_text` is truncated to 1,048,576 characters (1MB) when the assembled prompt exceeds this limit; `truncated` is set to `true` when capping occurs.
- Failure to insert is logged (`[prompt-capture] failed:`) but does not abort the dispatch — the spawn proceeds regardless.
- `dispatch_id` is set to `null` when the referenced dispatch is deleted (`ON DELETE SET NULL`), making the record permanently available for audit via `work_item_id`.
- Retrieved via `GET /api/work-items/:id/prompt-history`, sorted by `created_at DESC`.

## RegistryEntry

Stored in `portfolio/registry.json`.

```json
{
  "version": 1,
  "entries": {
    "/absolute/path": {
      "org": "string",
      "project": "string",
      "component": "string"
    }
  }
}
```
