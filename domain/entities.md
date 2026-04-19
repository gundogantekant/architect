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

**Read-only agents**: reviewer, security-auditor, performance, strategist, classifier, coordinator, scout, debugger, dependency-manager, tech-reviewer-swe, tech-reviewer-arch, tech-reviewer-dx, tech-reviewer-ux, tech-reviewer-frontend, tech-reviewer-dba, tech-reviewer-pm, tech-reviewer-systems, tech-reviewer-iot, tech-reviewer-prod
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
  "stop_conditions": "string[] | null — conditions requiring the agent to halt and report; null for trivial/small"
}
```

**Rules**: All four core fields (goal, constraints, expected_output, failure_conditions) are required when the contract is present. `scope_boundary` is required for large complexity, optional for medium, absent for trivial/small. `stop_conditions` is required for large complexity (3+ conditions), optional for medium, absent for trivial/small. Each string field should be 1–3 sentences. Empty strings are treated as absent (see `domain/rules.md` → Dispatch Contract Rules). The coordinator produces contracts as part of the DispatchPlan; the prompt-builder renders them in the dispatch prompt.

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
  "worktree_mode": "auto|explicit (default: auto — 'auto' creates worktrees by default, 'explicit' only when user explicitly requests)",
  // worktree_mode: must always be set explicitly. When "explicit" is chosen, a rationale entry in
  // custom_rules is required per domain/rules.md → Worktree Rules.
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

Stored in SQLite (`work_items` table). The project key (`org/project/component`) provides the project context, so items do not carry a redundant `project` field.

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

Stored in SQLite (`work_item_approvals` table). Normalized approver records supporting sequential ordering and cross-project blocking dependencies.

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

Backed by SQLite at `work/architect.db`. Migrations handle versioning. The API still returns this shape for backward compatibility.

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

Ephemeral (in-memory only, not persisted to SQLite) state derived from stream-json events during a dispatch session's lifetime. Tracks what the dispatched agent is currently doing. Reset to null when the dispatch reaches a terminal status.

Values:
- `worktree_setup` — dispatch infrastructure is creating and provisioning the worktree before agent spawn
- `generating` — agent is producing text (thinking, planning, responding)
- `tool_running` — agent dispatched a tool call, execution in progress
- `waiting_for_input` — agent finished its turn (stop_reason=end_turn), waiting for user
- `null` — dispatch in terminal state (completed/failed/killed/interrupted) or phase unknown

## DispatchRequest

Record created when the dashboard dispatches a Claude agent for a work item. Persisted to SQLite `dispatches` table (excluding process handles and listeners). Output streamed to `work/logs/D-xxx.jsonl`. On restart, sessions with live PIDs are reconnected via log file tailing; others are marked `interrupted`.

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
  "status": "running|completed|failed|killed|interrupted|suspended",
  "started_at": "string (ISO 8601)",
  "completed_at": "string (ISO 8601, optional)",
  "session_id": "string (Claude session ID, optional — legacy field)",
  "claude_session_id": "string (Claude CLI session UUID, optional — captured from stream-json init event, used for resume)",
  "cost_usd": "number (total cost, optional)",
  "pid": "number (OS process ID, optional — stored for restart survival)",
  "agent_phase": "AgentPhase (ephemeral, in-memory only — not persisted to SQLite, derived from live stream-json event parsing or log replay)",
  "worktree_path": "string (absolute path to worktree, null if no worktree — persisted to SQLite)",
  "worktree_branch": "string (worktree branch name, null if no worktree — persisted to SQLite)",
  "source_branch": "string (originating branch the worktree was created from, null if no worktree — persisted to SQLite)"
}
```

## TerminalSession

Record for an interactive PTY terminal session spawned from the dashboard. Persisted to SQLite `terminals` table (excluding ptyProcess, scrollback, wsClients). When tmux is available, terminals are wrapped in tmux sessions for restart survival. On restart, tmux sessions are re-attached; PID-only sessions are marked as detached; dead sessions are marked `interrupted`.

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
  "claude_session_id": "string (Claude CLI session UUID, optional — pre-assigned via --session-id at spawn, used for resume)"
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

Sessions are persisted in SQLite tables (`dispatches`, `terminals`, `cli_sessions`) in `work/architect.db`. Dispatch output is logged to `work/logs/D-xxx.jsonl` files. On startup, sessions with live PIDs (or tmux sessions) are reconnected; legacy sessions without PIDs are marked `interrupted`. The API returns this shape for backward compatibility:

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
  "trigger": "stale|blocked-chain|epic-stall|cost-anomaly|dispatch-loop",
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

## DashboardPreferences

Key-value pairs stored in the `preferences` table in SQLite. Used for dashboard-wide settings.

```json
{
  "default_permission_mode": "plan|acceptEdits",
  "default_skip_permissions": "true|false"
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
