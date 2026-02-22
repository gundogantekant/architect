# Architect: SDLC Agent System

## Overview

This project provides 19 specialized Claude Code subagents and 12 slash commands for complete software development lifecycle management. It is technology-flexible, local-first, and adapts to any project's stack.

## Agent Dispatch Guide

### When to use which agent

| Task | Agent | Model |
|------|-------|-------|
| Triage and dispatch planning | pm | sonnet |
| Scan a project's tech stack | scout | haiku |
| Strategic evaluation of a request | strategist | opus |
| Architecture/design decisions | planner | opus |
| General code implementation | coder | inherit |
| Frontend/UI work | coder-frontend | inherit |
| Backend/API work | coder-backend | inherit |
| Mobile development | coder-mobile | inherit |
| Infrastructure/DevOps | coder-infra | sonnet |
| Write/run tests | tester | sonnet |
| Code review | reviewer | opus |
| Security audit | security-auditor | opus |
| Bug investigation | debugger | sonnet |
| Performance optimization | performance | sonnet |
| CI/CD pipelines | ci-cd | sonnet |
| Documentation | documenter | sonnet |
| API design/schemas | api-designer | opus |
| Dependency management | dependency-manager | haiku |
| Work item tracking | tracker | haiku |

### Coordination Patterns

The main Claude conversation acts as orchestrator. Subagents cannot spawn subagents.

**PM-Guided Dispatch** (non-trivial work requests):
```
pm (triage) → follow execution plan: scout → [strategist] → planner → coders → tester → reviewer
```

PM classifies the request, selects the workflow, orders agents, and flags clarifications. The main conversation then follows PM's execution plan.

**Sequential Pipeline** (new features):
```
scout → [strategist] → planner → coder → tester → reviewer
```

**Strategic Evaluation** (before committing to build):
```
strategist → planner → coders
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

**Review Feedback Loop** (quality enforcement):
```
coder → reviewer → coder (address) → reviewer (re-check)
```

### PM Dispatch Rules

Invoke PM for:
- Work requests that involve multiple agents or unclear scope
- Requests where the right workflow pattern is not obvious
- Situations with no existing scout report on an unfamiliar project

Skip PM for:
- Slash commands (`/review`, `/test`, `/deploy`, etc.) — execute the skill directly
- Direct questions about code or architecture — answer directly
- Trivial tasks (typo fix, single-line change) — dispatch directly
- Explicit agent invocations where the user names the agent

### Adaptability

The **scout** agent produces a detection report that all other agents use for context. Always run scout first on unfamiliar projects. Pass scout's output to implementation agents so they generate code matching the project's stack.

## Project Portfolio

All onboarded project context lives in `portfolio/` with a three-level hierarchy: `portfolio/<org>/<project>/<component>.json`.

### Context Loading (required step 1 for all skills)

1. Resolve the target project path (from cwd or skill arguments)
2. Look up the path in `portfolio/registry.json` → get `{org, project, component}`
3. If found: read `portfolio/<org>/<project>/<component>.json` (scout report, agents, guidance)
4. Also read `portfolio/<org>/organization.json` (shared conventions, branch rules)
5. If not found: suggest `/onboard` first, or fall back to inline scout
6. Pass combined context to all agents in subsequent steps

### Key Files

| File | Purpose |
|------|---------|
| `portfolio/registry.json` | Path → portfolio location lookup |
| `portfolio/<org>/organization.json` | Org-level shared conventions |
| `portfolio/<org>/<project>/<component>.json` | Component profile (scout + agents + guidance) |

### Rules

- Never write CLAUDE.md or agent config to target project repos
- All project context stays in the architect portfolio
- Run `/onboard <path>` before dispatching implementation agents on a new project
- Use `/onboard <path> rescan` to refresh an existing profile

## Work Tracking

Persistent backlog in `work/backlog.json` for cross-session task tracking. Use `/work` to view open items at session start. Items link to portfolio projects via `org/project/component` references.

- PM suggests work items for medium+ complexity requests — create only after user confirmation
- Use `/work log <ID> <message>` to record progress before ending a session
- Statuses: `open`, `in-progress`, `blocked`, `done`, `cancelled`

## Rules

- Run scout (or load portfolio) before dispatching implementation agents on any new project
- Pass the portfolio context or detection report to every subsequent agent invocation
- Use parallel fan-out when tasks are independent (frontend/backend/infra)
- Use sequential pipeline when output feeds into the next step
- Read-only agents (reviewer, security-auditor, performance, strategist, pm) do not modify code (strategist can write decision docs to docs/)
- Implementation agents (coder-*) use acceptEdits permission mode
- Follow the user's CLAUDE.md rules: no push to main, no --no-verify, feature branches only
- For Neuronic projects, enforce GEN-XXX branch/PR naming

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
