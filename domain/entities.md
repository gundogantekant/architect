# Domain Entities

Canonical schemas for all structured data in the architect system. Agents and skills reference this file instead of embedding schemas inline.

## Agent

```json
{
  "name": "string",
  "role": "string",
  "model": "opus|sonnet|haiku|inherit",
  "read_only": "boolean",
  "max_turns": "number"
}
```

**Read-only agents**: reviewer, security-auditor, performance, strategist, pm, scout, debugger, dependency-manager
**Interactive agents**: browser (interacts with web via Playwright, no code/data writes)
**Implementation agents**: coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer, documenter, refactorer
**Onboarding agents**: profiler (writes only CLAUDE.md to the target project)
**Data-write agents**: tracker (uses dashboard API (http://127.0.0.1:3777/api/...) for work item and epic CRUD; writes work/epics/E-XXX/*.md and work/items/W-XXX/*.md for artifacts)

## RequestClassification

Output by PM when triaging a request.

```json
{
  "type": "feature|bugfix|refactor|question|review|deploy|maintenance|strategic|investigation",
  "complexity": "trivial|small|medium|large",
  "confidence": "number (0.0-1.0)"
}
```

## WorkflowPattern

```
"sequential|parallel-fan-out|plan-then-execute|investigate-then-fix|strategic-evaluation|direct"
```

## DispatchPlan

Full PM output. References RequestClassification and WorkflowPattern.

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
        "parallel_with": ["string (agent names)"]
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

**Rules**: `suggested_work_item` only for medium+ complexity. `skip_reason` mutually exclusive with `execution_plan.steps`.

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
  "worktree_mode": "auto|explicit (default: auto — 'auto' creates worktrees by default, 'explicit' only when user explicitly requests)",
  "worktree_setup": {
    "copy_paths": ["string — relative paths to copy from source to worktree"],
    "post_commands": ["string — shell commands to run in worktree after copy"]
  }
}
```

**Optional fields**: `brief`, `doc_paths`, `portfolio_guides`, `worktree_mode`, and `worktree_setup` are absent on entries onboarded before the profiler was added or where no setup is needed.

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

**Optional fields**: `design_systems`, `cloud_environments`.

## WorkItem

Stored in `work/backlog.json` under `projects[key].items`. The project key (`org/project/component`) provides the project context, so items do not carry a redundant `project` field.

```json
{
  "id": "string (W-XXX format, zero-padded)",
  "title": "string",
  "status": "open|in-progress|blocked|done|cancelled",
  "priority": "low|medium|high|critical",
  "description": "string",
  "epic_id": "string (E-XXX or empty, optional)",
  "project_key": "string (org/project/component) — derived from storage location, included in API responses",
  "created_at": "string (ISO 8601)",
  "updated_at": "string (ISO 8601)",
  "depends_on": ["string (W-XXX)"],
  "tags": ["string"],
  "session_log": [
    { "date": "string (ISO 8601)", "summary": "string" }
  ]
}
```

### Work Item Artifact Directory

Work item artifacts (plans, documentation) are stored as files at `work/items/W-XXX/`:
- `plan.md` — implementation plan
- `docs.md` — documentation and notes

Directories are created lazily on first write. The `notes` field on WorkItem is **deprecated** — existing content is migrated to `work/items/W-XXX/docs.md` by the v4→v5 migration.

## Epic

Top-level entity in `work/backlog.json` under the `epics` array. Epics group work items across projects into strategic goals.

```json
{
  "id": "string (E-XXX format, zero-padded)",
  "title": "string",
  "status": "draft|active|done|cancelled",
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
  "ticket_id": "string (Notion ticket ID, e.g. GEN-1641)"
}
```

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
  "status": "running|completed|failed|killed|interrupted",
  "started_at": "string (ISO 8601)",
  "completed_at": "string (ISO 8601, optional)",
  "session_id": "string (Claude session ID, optional)",
  "cost_usd": "number (total cost, optional)",
  "pid": "number (OS process ID, optional — stored for restart survival)"
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
  "status": "running|completed|failed|killed|interrupted",
  "started_at": "string (ISO 8601)",
  "exited_at": "string (ISO 8601, null while running)",
  "pid": "number (OS process ID, optional — stored for restart survival)",
  "tmux_session": "string (tmux session name, optional — e.g. architect-T-xxx)"
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

## DashboardPreferences

Key-value pairs stored in the `preferences` table in SQLite. Used for dashboard-wide settings.

```json
{
  "default_permission_mode": "plan|acceptEdits",
  "default_skip_permissions": "true|false"
}
```

Accessed via `GET/PUT /api/settings/preferences`.

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
