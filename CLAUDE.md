# Architect: SDLC Agent System

## Terminology

When the user says "architect" in conversation, it primarily refers to **this project** — the SDLC Agent System at `~/Documents/architect`. This is the default meaning. However, "architect" can also carry its standard meanings (technical architect, database architect, security architect, etc.) when the surrounding context clearly indicates one of those. The project name does not override those meanings — it simply takes priority as the default interpretation.

## Overview

This project provides 22 specialized Claude Code subagents and 16 slash commands for complete software development lifecycle management. It is technology-flexible, local-first, and adapts to any project's stack.

## Architecture

Clean Architecture with four layers. Dependencies point inward only.

| Layer | Location | Contents |
|-------|----------|----------|
| Domain | `domain/` | Entity schemas (`entities.md`), business rules (`rules.md`) |
| Use Cases | `usecases/` | Workflow definitions (17 files, one per skill workflow) |
| Adapters | `.claude/agents/`, `.claude/skills/` | Agent prompts, skill entry points |
| Infrastructure | `portfolio/`, `work/`, `templates/` | Instance data (gitignored), project templates |

See `docs/architecture.md` for layer boundaries and dependency rules.

## Agent Dispatch Guide

### When to use which agent

| Task | Agent | Model |
|------|-------|-------|
| Triage and dispatch planning | pm | sonnet |
| Scan a project's tech stack | scout | haiku |
| Project analysis and CLAUDE.md generation | profiler | sonnet |
| Strategic evaluation of a request | strategist | opus |
| Architecture/design decisions | planner | opus |
| General code implementation | coder | inherit |
| Frontend/UI work | coder-frontend | inherit |
| Backend/API work | coder-backend | inherit |
| Mobile development | coder-mobile | inherit |
| Infrastructure/DevOps | coder-infra | sonnet |
| Write/run tests | tester | sonnet |
| Code review | reviewer | sonnet |
| Security audit | security-auditor | opus |
| Bug investigation | debugger | sonnet |
| Performance optimization | performance | sonnet |
| CI/CD pipelines | ci-cd | sonnet |
| Documentation | documenter | sonnet |
| API design/schemas | api-designer | sonnet |
| Dependency management | dependency-manager | haiku |
| Work item tracking | tracker | haiku |
| Systematic refactoring | refactorer | sonnet |
| Browser automation (E2E, visual, web tasks) | browser | sonnet |

### Coordination Patterns

The main Claude conversation acts as orchestrator. Subagents cannot spawn subagents.

**PM-Guided Dispatch** (non-trivial work requests):
```
pm (triage) → follow execution plan: scout → [strategist] → planner → coders → tester → reviewer
```

**Sequential Pipeline** (new features):
```
scout → [strategist] → planner → coder → tester → reviewer
```

**Parallel Fan-Out** (full-stack features):
```
Spawn in parallel: coder-frontend + coder-backend + coder-infra
Then: tester → reviewer
```

**Plan-Then-Execute** (large features):
```
planner (produces task list) → dispatch coders per task
```

**Investigate-Then-Fix** (bug fixing):
```
debugger/scout → coder (fix) → tester (verify)
```

See `domain/rules.md` for PM dispatch rules, workflow selection matrix, and agent inclusion rules.

## Project Portfolio

All onboarded project context lives in `portfolio/` (gitignored, local instance data created by `/onboard`) with a three-level hierarchy: `portfolio/<org>/<project>/<component>.json`.

### Key Files

| File | Purpose |
|------|---------|
| `portfolio/registry.json` | Path → portfolio location lookup |
| `portfolio/<org>/organization.json` | Org-level shared conventions |
| `portfolio/<org>/<project>/<component>.json` | Component profile (scout + agents + guidance) |

### Context Loading

All skills follow `usecases/load-portfolio-context.md` as their first step. See that file for the full protocol and per-skill fallback strategies.

### Rules

- Onboarding generates a CLAUDE.md in target projects. No other agent config is written to target repos.
- All project context stays in the architect portfolio (CLAUDE.md in target is a convenience copy)
- Run `/onboard <path>` before dispatching implementation agents on a new project
- Use `/onboard <path> rescan` to refresh an existing profile

## Work Tracking

Persistent backlog in SQLite at `work/architect.db` using a project-keyed structure: items are nested under `projects["org/project/component"].items` instead of a flat array. IDs are globally unique (`W-XXX`). Use `/work` to view open items at session start. The dashboard API (`/api/backlog`, `/api/work-items/...`) provides the primary interface; the tracker agent uses these API endpoints instead of direct file access.

**Terminology**: task = ticket = work item. The dashboard UI uses "task" for brevity.

**Epics** (`E-XXX`) provide cross-project strategic grouping. Epics are top-level in `backlog.json` (not nested under a project key) and link to work items via bidirectional references. Epic plans and docs are stored at `work/epics/E-XXX/` (plan.md, docs.md). Use `/work epic list` to view active epics.

**Dependencies**: Items support multi-dependency tracking via `depends_on` array. Use `/work depend W-XXX W-YYY` to declare dependencies and `/work undepend` to remove them. Cycle detection prevents circular chains. CLI and dashboard display items in topological order.

Use `/work list --org <name>` to scope work items to a specific organization. See `domain/entities.md` → WorkItem, Epic, WorkBacklog for schemas, `domain/rules.md` → Work Item Rules, Epic Rules, and Dependency Rules for tracking rules, `docs/work-tracking.md` for full documentation.

## Rules

- Before any work (plans, agent dispatch, skill invocation), the orchestrator must resolve the target project with all five fields: Organization, Project, Component, Path, and Branch. If the target is ambiguous, ask the user. See `domain/rules.md` → Target Project Identification. For architect self-changes, use Organization=ticari, Project=architect, Component=main.
- Plan files must include a **Target Project** section (Organization, Project, Component, Path, Branch) immediately after the Context section when the work targets a specific project. For architect self-changes, include the architect target. See `domain/rules.md` → Target Project Identification for field definitions and detection steps.
- Run scout (or load portfolio) before dispatching implementation agents on any new project
- Pass the portfolio context or detection report to every subsequent agent invocation
- Use parallel fan-out when tasks are independent (frontend/backend/infra)
- Use sequential pipeline when output feeds into the next step
- Read-only agents do not modify code (see `domain/rules.md` → Agent Permission Model)
- Implementation agents (coder-*) use acceptEdits permission mode
- All work on portfolio projects uses a git worktree by default — create one before making any code changes. Skip only when the user explicitly opts out. See `domain/rules.md` → Worktree Rules.
- Follow git standards defined in `domain/rules.md`
- Before using Playwright MCP tools directly in the main session, follow Model Affinity Rules in `domain/rules.md` to prompt model switching

## Dashboard (`tools/dashboard/`)

Local web dashboard at `http://127.0.0.1:3777` for viewing portfolio data and work items. Start with `node tools/dashboard/server.mjs` or use `tools/dashboard/dashctl.sh start` for background lifecycle management.

### Server Lifecycle (`dashctl.sh`)

`tools/dashboard/dashctl.sh` manages the server process: `start`, `stop`, `restart`, `status`, `logs [-n N] [-f]`, `fresh [--clear-sessions]`, `install` (auto-start via launchd/systemd), `uninstall`, `help`. Uses `tmp/dashboard.pid` for PID tracking and `tmp/dashboard.log` for output. The `#settings` page in the dashboard provides a UI for these operations.

### Agent Dispatch

The dashboard supports dispatching Claude Code agents directly from work items:
- Click "dispatch" on any open/in-progress work item to open the dispatch modal
- Add optional instructions, then dispatch — spawns `claude -p --output-format stream-json` as a child process
- Live output streams to the browser via SSE; multiple dispatches run concurrently
- Each dispatch panel shows a terminal guidance command for taking over from CLI
- Session state persisted to `work/sessions.json` — survives server restarts. Previously-running sessions marked as `interrupted`. See `domain/entities.md` → DispatchRequest, TerminalSession, SessionsFile for schemas.
- Interactive terminals use xterm.js + WebSocket for bidirectional PTY I/O (node-pty). See `domain/entities.md` → TerminalSession for schema.
- Kill buttons on dispatch/terminal panels; "Kill All Sessions" button for bulk cleanup.
- Auto-cleanup: exited terminals removed after 10min, completed dispatches after 30min.
- `#agents` route: tile-based view of all dispatched agents, filterable by status/epic/project. Tiles show status, output preview, and support focus/kill actions. Quick dispatch modal available. Active list responses include `epic_id` and `last_output` fields.
- **Foldable panels**: minimize/expand dispatch and terminal panels. Collapse state persisted to sessionStorage across navigation.
- **Contextual placement**: session panels appear under their associated work item row in component/epic views. Standalone sessions fall back to a global container at the top.
- **Permission modes**: dispatch modal includes permission mode selector — "Plan only", "Accept edits" (default), "Full auto (skip permissions)". Panels show `[auto]` badge for full-auto, `[plan]` for plan mode.
- **Grouped sidebar**: sessions sidebar groups entries by epic, with standalone sessions below. Clicking navigates to the session's context view.
- **Architect-awareness**: dispatched agents receive `ARCHITECT_ROOT` env var and `# Environment` / `# Tracking` sections in their prompt with dashboard API endpoints for status updates and log entries.
- **CLI session registration**: external CLI sessions can register as read-only entries via `POST /api/sessions/register`. The dashboard shows them with a `[CLI]` badge, teal left border, and no kill/focus buttons. PID liveness is checked every 60s; exited CLI sessions are auto-cleaned after 10min. Persisted in `work/sessions.json` under `cli_sessions`. See `domain/entities.md` → CliSession for schema.

Server endpoints: `POST /api/dispatch`, `GET /api/dispatch/:id/stream` (SSE), `GET /api/dispatch/active`, `DELETE /api/dispatch/:id`, `DELETE /api/dispatch/all`. Terminal endpoints: `POST /api/terminal`, `GET /api/terminal/active`, `DELETE /api/terminal/:id`, `DELETE /api/terminal/all`, `WS /api/terminal/:id/ws`. CLI session endpoints: `POST /api/sessions/register`, `GET /api/sessions/active`, `DELETE /api/sessions/:id`. Server management endpoints: `GET /api/server/status`, `GET /api/server/config`, `POST /api/server/action`, `GET /api/server/logs`. Epic endpoints: `GET/POST /api/epics`, `GET/PATCH/DELETE /api/epics/:id`, `POST /api/epics/:id/link`, `POST /api/epics/:id/unlink`, `GET/PUT /api/epics/:id/plan`, `GET/PUT /api/epics/:id/doc`. Work item artifact endpoints: `GET/PUT /api/work-items/:id/plan`, `GET/PUT /api/work-items/:id/doc`, `GET /api/work-items/:id/artifacts`, `GET/PUT/DELETE /api/work-items/:id/artifacts/:filename`. Preferences endpoints: `GET/PUT /api/settings/preferences`.

## Available Skills

| Command | Purpose |
|---------|---------|
| /onboard [path] [--organization org] [rescan] | Scan and register project in portfolio |
| /portfolio [list\|show\|remove] | View and manage project portfolio |
| /scaffold [type] [name] | Create new project from template |
| /review [scope] | Comprehensive code review |
| /test [scope] | Run and generate tests |
| /deploy [target] | Local deployment |
| /pr [base-branch] | Create PR with review summary |
| /diagnose [issue] | Debug an issue |
| /secure | Security audit |
| /status | Project health check |
| /work [subcommand] [args] | Track work items across sessions |
| /migrate [from] [to] | Technology migration |
| /explain [path] [--focus area] | Codebase walkthrough |
| /release [version] [--publish github] | Version bump, changelog, git tag |
| /refactor [scope] | Systematic refactoring |
| /browse [task] | Perform a web automation task via browser agent |
| /worktree [list\|cleanup] | Manage git worktrees for implementation isolation |
