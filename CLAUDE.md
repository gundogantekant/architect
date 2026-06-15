# Architect: SDLC Agent System

## Terminology

When the user says "architect" in conversation, it primarily refers to **this project** — the SDLC Agent System at `~/Documents/architect`. This is the default meaning. However, "architect" can also carry its standard meanings (technical architect, database architect, security architect, etc.) when the surrounding context clearly indicates one of those. The project name does not override those meanings — it simply takes priority as the default interpretation.

## Overview

This project provides 34 specialized Claude Code subagents and 19 slash commands for complete software development lifecycle management. It is technology-flexible, local-first, and adapts to any project's stack. The main thread acts as a strict orchestrator/PM — it reads, plans, dispatches, and tracks, but delegates all implementation and git operations to specialized agents.

## Architecture

Clean Architecture with four layers. Dependencies point inward only.

| Layer | Location | Contents |
|-------|----------|----------|
| Domain | `domain/` | Entity schemas (`entities.md`), business rules (`rules.md`) |
| Use Cases | `usecases/` | Workflow definitions (19 files, one per skill workflow) |
| Adapters | `.claude/agents/`, `.claude/skills/` | Agent prompts, skill entry points |
| Infrastructure | `portfolio/`, `work/`, `templates/` | Instance data (gitignored), project templates |

See `docs/architecture.md` for layer boundaries and dependency rules.

## Agent Dispatch Guide

### When to use which agent

| Task | Agent | Default Model |
|------|-------|---------------|
| Fast request triage | classifier | haiku |
| Detailed dispatch planning | coordinator | sonnet |
| Synthesize investigation findings into a DispatchPlan | findings-coordinator | sonnet |
| Scan a project's tech stack | scout | haiku |
| Project analysis and CLAUDE.md generation | profiler | sonnet |
| Strategic evaluation of a request | strategist | opus |
| Architecture/design decisions | planner | opus |
| General code implementation | coder | sonnet |
| Frontend/UI work | coder-frontend | sonnet |
| Backend/API work | coder-backend | sonnet |
| Mobile development | coder-mobile | sonnet |
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
| Design-partner conversations about the project | discuss | sonnet |
| Git operations (commit, push, PR, branch, worktree) | git-ops | haiku |
| Tech review — SWE perspective | tech-reviewer-swe | sonnet |
| Tech review — architecture (Clean Architecture) | tech-reviewer-arch | sonnet / opus* |
| Tech review — project management | tech-reviewer-pm | sonnet |
| Tech review — frontend perspective | tech-reviewer-frontend | sonnet |
| Tech review — UX perspective | tech-reviewer-ux | sonnet |
| Tech review — DX perspective | tech-reviewer-dx | sonnet |
| Tech review — database architecture | tech-reviewer-dba | sonnet |
| Tech review — systems engineering | tech-reviewer-systems | sonnet / opus* |
| Tech review — IoT engineering | tech-reviewer-iot | sonnet |
| Tech review — production readiness | tech-reviewer-prod | sonnet |
| Tech review — security (diff-scoped, code gate) | tech-reviewer-security | sonnet |

*Escalated to opus when dispatched for large or strategic artifacts.

Default models are overridden dynamically by the orchestrator based on task complexity. See `domain/rules.md` → Model Selection Rules → Review Board Escalation.

For the recommended orchestrator session model and escalation triggers, see `domain/rules.md` → Orchestrator Behavior Rules → Orchestrator Session Model (Operator Guidance).

### Orchestrator Behavior

The main thread is strictly an orchestrator/PM. It reads, plans, dispatches, and tracks — but does not implement code (except single-line trivial fixes like typos). Git operations are delegated to the git-ops agent. See `domain/rules.md` → Orchestrator Behavior Rules for the full dispatch decision flow.

When an investigation agent completes and follow-up dispatch is needed: if a `ClassifierOutput` is already in scope, route through coordinator (triage-request workflow); if only unstructured findings exist, route through findings-coordinator (synthesize-findings workflow).

### Session Identity & Scope

Every session carries a `SessionIdentity` that determines its permissions. The orchestrator (depth 0) has full capabilities; dashboard-dispatched agents (depth 1) are restricted to their own work item scope and cannot trigger further dashboard dispatches. Depth 2+ is forbidden — sub-agents of dispatched agents run in-process only. See `domain/entities.md` → SessionIdentity and `domain/rules.md` → Session Scope Rules.

### Project Manager Behavior

The orchestrator acts as PM across all onboarded projects. At session start, it runs an async background check for active dispatches, blocked items, and stale work — surfacing a summary only when findings exist. It proactively detects escalation conditions (stale items, blocked chains, epic stalls, dispatch loops, cost anomalies) using the `EscalationLogEntry` format. See `domain/rules.md` → Project Manager Behavior Rules and `domain/entities.md` → EscalationLogEntry.

### Coordination Patterns

The main Claude conversation acts as orchestrator. Subagents cannot spawn subagents.

**Classifier + Coordinator Dispatch** (non-trivial work requests):
```
classifier (haiku, fast triage) → [pre-dispatch check (orchestrator, if work type + small+)] → [coordinator (sonnet, detailed plan)] → follow execution plan
```
For simple cases (trivial/small, high confidence), the orchestrator skips the coordinator and constructs a dispatch plan directly from the classifier output. Pre-dispatch check runs in parallel with coordinator when both are needed. See `domain/rules.md` → Pre-Dispatch Check Rules.

**Dispatch Contracts** (small+ complexity; for trivial items the `goal` field in the step's `purpose` serves as the minimum success term): Each step in the coordinator's DispatchPlan includes a `DispatchContract` (Goal, Constraints, Expected Output, Failure Conditions + optional Scope Boundary, Stop Conditions) that defines clear success criteria and session governance for the dispatched agent. Contracts flow into sub-agent prompts and are used by the Review Board to evaluate whether implementation meets stated goals. For long-running sessions, the contract's scope_boundary and stop_conditions provide self-enforcement guardrails. Work items must have a valid contract (at minimum a goal) to transition from `open` to `ready` status; only `ready`+ items are dispatchable from the dashboard. See `domain/entities.md` → DispatchContract, `domain/rules.md` → Dispatch Contract Rules, and `domain/rules.md` → Long-Running Session Rules.

**Review Board** (two-gate lifecycle for small+ work):
```
Plan Gate:  planner → [tech-reviewer-swe + tech-reviewer-arch + tech-reviewer-pm + (context-dependent: frontend, ux, dx, dba, systems, prod, iot)] (parallel)
  → aggregate verdicts → if block: revise + re-review (max 2 cycles) → status: ready

Code Gate:  coder → tester → [tech-reviewer-* board] (parallel) + reviewer (detailed)
  → aggregate verdicts → if block: fix + re-review → commit/merge
```
Board composition is context-filtered (3–10 agents). See `domain/rules.md` → Review Board Rules.

**Sequential Pipeline** (new features):
```
scout → [strategist] → planner → tech review board (plan gate) → coder → tester → tech review board (code gate) → reviewer → git-ops (commit)
```

**Parallel Fan-Out** (full-stack features):
```
Spawn in parallel: coder-frontend + coder-backend + coder-infra
Then: tester → reviewer → git-ops (commit)
```

**Plan-Then-Execute** (large features):
```
planner (produces task list with parallel batches) → dispatch batches concurrently, sequential between batches
```

**Investigate-Then-Fix** (bug fixing):
```
debugger/scout → coder (fix) → tester (verify) → git-ops (commit)
```

**Dispatch-Level Worktree Isolation**: When the dashboard dispatches an agent with `acceptEdits` permission mode + a work item + `worktree_mode: "auto"`, the dispatch infrastructure creates a git worktree **before** spawning the agent. The agent starts with `cwd` set to the worktree. This prevents conflicts between parallel dispatches on the same project. The agent receives a `# Worktree Context` prompt section and skips its own worktree creation (implement-work-item step 8). Controlled by the `worktree_at_dispatch` dashboard preference. See `domain/rules.md` → Worktree Rules.

See `domain/rules.md` for triage dispatch rules, workflow selection matrix, agent inclusion rules, model selection rules, and role-scoped context injection.

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

Persistent backlog in PostgreSQL (via Docker, `tools/dashboard/docker-compose.yml`) using a project-keyed structure: items are nested under `projects["org/project/component"].items` instead of a flat array. IDs are globally unique (`W-XXX`). Use `/work` to view open items at session start. The dashboard API (`/api/backlog`, `/api/work-items/...`) provides the primary interface; the tracker agent uses these API endpoints instead of direct file access.

**Terminology**: task = ticket = work item. The dashboard UI uses "task" for brevity.

**Epics** (`E-XXX`) provide cross-project strategic grouping. Epics are top-level in `backlog.json` (not nested under a project key) and link to work items via bidirectional references. Epic plans and docs are stored at `work/epics/E-XXX/` (plan.md, docs.md). Use `/work epic list` to view active epics.

**Dependencies**: Items support multi-dependency tracking via `depends_on` array. Use `/work depend W-XXX W-YYY` to declare dependencies and `/work undepend` to remove them. Cycle detection prevents circular chains. CLI and dashboard display items in topological order.

Use `/work list --org <name>` to scope work items to a specific organization. See `domain/entities.md` → WorkItem, Epic, WorkBacklog for schemas, `domain/rules.md` → Work Item Rules, Epic Rules, and Dependency Rules for tracking rules, `docs/work-tracking.md` for full documentation.

## Rules

- Before any work (plans, agent dispatch, skill invocation), the orchestrator must resolve the target project with all five fields: Organization, Project, Component, Path, and Branch. If the target is ambiguous, ask the user. See `domain/rules.md` → Target Project Identification. For architect self-changes, use Organization=ticari, Project=architect, Component=main.
- Plan files must include a **Target Project** section (Organization, Project, Component, Path, Branch) immediately after the Context section when the work targets a specific project. For architect self-changes, include the architect target. See `domain/rules.md` → Target Project Identification for field definitions and detection steps.
- Run scout (or load portfolio) before dispatching implementation agents on any new project
- Pass the portfolio context or detection report to every subsequent agent invocation
- Include the Coding Standards Brief (from `domain/rules.md` → Coding Standards Brief) in every implementation agent dispatch prompt. Sub-agents do not inherit standards automatically.
- When dispatching multiple agents or tasks, apply `domain/rules.md` → Parallelization Rules: evaluate independence criteria, dispatch independent work concurrently, fall back to sequential only when independence is not provable. This applies to all workflow patterns, not only parallel-fan-out.
- Read-only agents do not modify code (see `domain/rules.md` → Agent Permission Model)
- Implementation agents (coder-*, git-ops) use acceptEdits permission mode
- The orchestrator delegates all git operations (commit, push, PR, branch, worktree) to the git-ops agent. The orchestrator only runs read-only git commands (status, log, diff) directly.
- Architect self-implementations (ticari/architect/main): after tests pass (or Code Gate approves when no test suite applies) and no scope violations are present, merge directly to the originating branch. No GitHub PR is created or needed. On unresolvable merge conflict, leave the worktree open — do not offer `/pr` as a fallback.
- Apply role-scoped context injection when dispatching agents — see `domain/rules.md` → Role-Scoped Context Injection for the tier mapping per agent role. Before each dispatch, look up the agent in `domain/rules.md` → Context Tier Mapping to determine which portfolio fields to include.
- Use dynamic model selection per dispatch — see `domain/rules.md` → Model Selection Rules for complexity-to-model mapping
- The orchestrator dispatches sub-agents for research, analysis, and investigation tasks. The main session decomposes, dispatches, and synthesizes — sub-agents execute. See `domain/rules.md` → Dispatch-First Rule for trigger criteria. Structure every Agent tool dispatch using the template in `domain/rules.md` → Agent Dispatch Standards.
- All work on portfolio projects uses a git worktree by default — create one before making any code changes. Exception: projects with `worktree_mode: "explicit"` in their portfolio entry work in-place; worktrees are created only on explicit request. Skip only when the user explicitly opts out. See `domain/rules.md` → Worktree Rules.
- Follow git standards defined in `domain/rules.md`
- Before using Playwright MCP tools directly in the main session, follow Model Affinity Rules in `domain/rules.md` to prompt model switching
- Every implementation plan must include `success_criteria` and `e2e_test_criteria` before any coding begins. Trivial changes use the `goal` field as the minimum success term; formal `e2e_test_criteria` entries are exempt for trivial. See `domain/rules.md` → Contract-First Planning Rules.
- For small+ complexity dispatches, ensure DispatchContracts (all four core fields + `success_criteria` + `e2e_test_criteria` for small+; Scope Boundary + Stop Conditions for large) from the coordinator's or orchestrator's plan are propagated to sub-agent prompts. See `domain/rules.md` → Dispatch Contract Rules and Long-Running Session Rules.

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
- Session state persisted to PostgreSQL (`dispatches`, `terminals`, `cli_sessions` tables). See `domain/entities.md` → DispatchRequest, TerminalSession, SessionsFile for schemas.
- **Session restart survival**: Dispatch sessions store PID and stream output to `work/logs/D-xxx.jsonl`; on restart, live PIDs are reconnected with log replay via SSE. Terminal sessions use tmux (when available) for full PTY re-attachment; otherwise PID liveness is tracked. Log files are cleaned up when dispatches are deleted or auto-expire.
- Interactive terminals use xterm.js + WebSocket for bidirectional PTY I/O (node-pty). See `domain/entities.md` → TerminalSession for schema.
- Kill buttons on dispatch/terminal panels; "Kill All Sessions" button for bulk cleanup.
- Sessions persist until explicitly dismissed by the user — no auto-cleanup timers.
- `#agents` route: tile-based view of all dispatched agents, filterable by status/epic/project. Tiles show status, output preview, and support focus/kill actions. Quick dispatch modal available. Active list responses include `epic_id` and `last_output` fields.
- **Foldable panels**: minimize/expand dispatch and terminal panels. Collapse state persisted to sessionStorage across navigation.
- **Contextual placement**: session panels appear under their associated work item row in component/epic views. Standalone sessions fall back to a global container at the top.
- **Permission modes**: dispatch modal includes permission mode selector ("Plan only", "Accept edits", "Plan, then auto-execute") and a separate "Skip permissions" checkbox (`--dangerously-skip-permissions`). Panels show `[plan]` badge for plan mode and `[skip-perms]` badge when skip permissions is enabled. Both settings have independent defaults configurable in `#settings`.
- **Plan-then-execute mode** (`plan_execute`): a two-phase chained dispatch — phase 1 plans (plan-only process), then phase 2 resumes the same claude session with acceptEdits + `--dangerously-skip-permissions` in the same isolated worktree to implement autonomously. `plan_execute` is dashboard-only chain state, never an emitted `--permission-mode` flag (avoids claude bug #17544 where skip-perms silently overrides plan mode). Panels show a `[plan→exec]` badge in phase 1 and `[exec]` in phase 2. With autostart off, phase-1 completion holds at status `execute_pending` and an "Approve & Execute" action calls `POST /api/dispatch/:id/execute` to spawn phase 2. The architect project (`ticari/architect/main`) defaults to `plan_execute` with autostart on; other projects keep `acceptEdits`. Preference keys: `default_dispatch_mode` (global), per-project `default_dispatch_mode:<key>`, and `plan_execute_autostart`. Supported on `/api/dispatch` only; `/auto-implement` is out of scope.
- **DISPATCHES sidebar**: a single collapsible sidebar section (replaces the former AGENTS, AUTONOMOUS, and SESSIONS entries) with Active/Autonomous/All filter tabs. Tab selection persists in sessionStorage across the 3-second refresh interval. The `#autonomous` route pre-selects the Autonomous tab. Entries are grouped by project and epic; clicking navigates to the session's context view. `SESSION_AWARE_ROUTES` gates session panel visibility — analytical routes (time-report, costs) call `_hideSessionPanelsForCleanRoute()` and panels are restored via `display` toggle (never removed from DOM) when returning to a session-aware route.
- **Architect-awareness**: dispatched agents receive `ARCHITECT_ROOT` env var, a `# Architect System` section (portfolio entry path, guides, domain rules pointers), role-scoped portfolio context (filtered by agent tier per `domain/rules.md` → Role-Scoped Context Injection), a `# Context Tiers` section for sub-agent dispatches, and `# Environment` / `# Tracking` sections with dashboard API endpoints for status updates and log entries.
- **CLI session registration**: external CLI sessions can register as read-only entries via `POST /api/sessions/register`. The dashboard shows them with a `[CLI]` badge, teal left border, and no kill/focus buttons. PID liveness is checked every 60s; exited CLI sessions are auto-cleaned after 10min. Persisted in `work/sessions.json` under `cli_sessions`. See `domain/entities.md` → CliSession for schema.

Server endpoints: `POST /api/dispatch`, `GET /api/dispatch/:id/log` (plain text JSONL), `GET /api/dispatch/:id/stream` (SSE, supports `?after=N`), `GET /api/dispatch/active`, `POST /api/dispatch/:id/execute` (spawn phase 2 of a gated `plan_execute` chain), `DELETE /api/dispatch/:id`, `DELETE /api/dispatch/all`. Terminal endpoints: `POST /api/terminal`, `GET /api/terminal/active`, `DELETE /api/terminal/:id`, `DELETE /api/terminal/all`, `WS /api/terminal/:id/ws`. CLI session endpoints: `POST /api/sessions/register`, `GET /api/sessions/active`, `DELETE /api/sessions/:id`. Server management endpoints: `GET /api/server/status`, `GET /api/server/config`, `POST /api/server/action`, `GET /api/server/logs`. Epic endpoints: `GET/POST /api/epics`, `GET/PATCH/DELETE /api/epics/:id`, `POST /api/epics/:id/link`, `POST /api/epics/:id/unlink`, `GET/PUT /api/epics/:id/plan`, `GET/PUT /api/epics/:id/doc`. Work item artifact endpoints: `GET/PUT /api/work-items/:id/plan`, `GET/PUT /api/work-items/:id/doc`, `GET /api/work-items/:id/artifacts`, `GET/PUT/DELETE /api/work-items/:id/artifacts/:filename`. Preferences endpoints: `GET/PUT /api/settings/preferences`.

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
| /implement [W-XXX] | Implement a tracked work item end-to-end |
| auto-implement-scheduler (paste prompt) | Continuous backlog driver — paste `usecases/auto-implement-scheduler.md` into dispatch modal Additional Instructions |
| /migrate [from] [to] | Technology migration |
| /explain [path] [--focus area] | Codebase walkthrough |
| /release [version] [--publish github] | Version bump, changelog, git tag |
| /refactor [scope] | Systematic refactoring |
| /sync [status|adr] | Sync portfolio knowledge base with external git changes; manage ADRs |
| /browse [task] | Perform a web automation task via browser agent |
| /worktree [list\|cleanup] | Manage git worktrees for implementation isolation |
| /review-board [gate] [scope] | Manually trigger the Technical Review Board on a plan or code diff |

## CodeGraph

`.codegraph/` is initialized at the architect project root. The index covers **code files only** — markdown files (agent prompts, use-case workflows, domain rules) are not indexed.

**Indexed corpus** (~230 files):
- `tools/dashboard/` — all `.mjs` files (server, dispatch manager, routes, DB, prompt builder, etc.)
- `tools/temporal/` — TypeScript workflows and activities
- `templates/` — scaffold TypeScript/TSX reference code
- `tools/ble-relay/`, `tools/dart-debug/` — Python utilities

### Code Discovery Preference (applies to orchestrator AND all dispatched agents)

**For any code-related discovery in architect's own indexed corpus** (`tools/dashboard/`, `tools/temporal/`, `templates/`, `tools/ble-relay/`, `tools/dart-debug/`):

| Task | Preferred tool | Fallback |
|------|---------------|----------|
| Find a function/constant/symbol | `codegraph_search` | grep / search_files |
| Trace who calls a function | `codegraph_callers` | grep -r |
| Trace what a function calls | `codegraph_callees` | manual read_file |
| Assess blast radius of a change | `codegraph_impact` | manual trace |
| Pull relevant context for a task | `codegraph_context` | search_files + read_file |

**Rationale**: CodeGraph tokenizes symbol-level queries and returns targeted results. Grep/search_files return raw text matches that consume 5–50x more tokens and require follow-up reads. Always reach for CodeGraph first when exploring indexed code files.

### Tools and when to use them

| Tool | Use for | Skip when |
|------|---------|-----------|
| `codegraph_search` | Find functions/constants in indexed code (dashboard/temporal/templates/ble-relay/dart-debug) | Exploring .md artifacts — use grep instead |
| `codegraph_callers` / `codegraph_callees` | Trace JS/TS function call chains in indexed code | Prompt flow or .md-only investigation |
| `codegraph_impact` | Blast radius for code changes before dispatch | Prompt-only or config-only changes |
| `codegraph_context` | Pull relevant JS/TS context for a task in indexed code | Non-code tasks |

### Freshness

- Check `codegraph_status` once at session start. Do not re-check per dispatch.
- Refresh trigger: run `codegraph index` only when **code files** in the indexed corpus (`tools/dashboard/`, `tools/temporal/`, `templates/`, `tools/ble-relay/`, `tools/dart-debug/`) are structurally changed (added, removed, renamed). Skip for prompt-only edits.
- **Freshness gate before trust**: before relying on CodeGraph results for discovery, verify `codegraph_status` reports the index is current. If stale, run `codegraph index` before using CodeGraph tools. An outdated index means stale call graphs and missing symbols — worse than grep because the results look authoritative but are wrong.
- Fallback: if `codegraph_status` errors or is unavailable, use grep/find. Never block on CodeGraph availability.

### Explore agents

Explore agents are lightweight read-only subagents the orchestrator dispatches for code discovery (reading >3 files, tracing call chains, understanding patterns). They are not named agents — the orchestrator dispatches them inline via `delegate_task` with code-reading instructions.

When spawning an Explore agent for architect's own indexed code:
- **Before dispatching**: check `codegraph_status` — if the index is stale, run `codegraph index` first. Do not dispatch an agent with an outdated code graph.
- Include the full **Code Discovery Preference** table above in the agent's context. The table is your prompt-injection — paste it verbatim.
- Add: "Prefer CodeGraph tools over grep/search_files for all symbol lookup in indexed code. Fall back to grep only for .md artifacts or when CodeGraph is unavailable."

When spawning an Explore agent for a **target project** with `.codegraph/` present (per `load-portfolio-context.md` → Step 5):
- Include the CodeGraph subsection from the portfolio context in the agent's prompt.
- Add: "Use codegraph_search, codegraph_callers, codegraph_callees for JS/TS symbol lookups. Fall back to grep for .md artifacts."

When spawning an Explore agent for a project WITHOUT CodeGraph:
- Use search_files and read_file as usual. No CodeGraph instructions needed.
