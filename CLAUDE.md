# Architect: SDLC Agent System

## Overview

This project provides 16 specialized Claude Code subagents and 10 slash commands for complete software development lifecycle management. It is technology-flexible, local-first, and adapts to any project's stack.

## Agent Dispatch Guide

### When to use which agent

| Task | Agent | Model |
|------|-------|-------|
| Scan a project's tech stack | scout | haiku |
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

### Coordination Patterns

The main Claude conversation acts as orchestrator. Subagents cannot spawn subagents.

**Sequential Pipeline** (new features):
```
scout → planner → coder → tester → reviewer
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

### Adaptability

The **scout** agent produces a detection report that all other agents use for context. Always run scout first on unfamiliar projects. Pass scout's output to implementation agents so they generate code matching the project's stack.

## Rules

- Run scout before dispatching implementation agents on any new project
- Pass the detection report context to every subsequent agent invocation
- Use parallel fan-out when tasks are independent (frontend/backend/infra)
- Use sequential pipeline when output feeds into the next step
- Read-only agents (reviewer, security-auditor, performance) do not modify code
- Implementation agents (coder-*) use acceptEdits permission mode
- Follow the user's CLAUDE.md rules: no push to main, no --no-verify, feature branches only
- For Neuronic projects, enforce GEN-XXX branch/PR naming

## Available Skills

| Command | Purpose |
|---------|---------|
| /onboard [path] | Apply architect to existing project |
| /scaffold [type] [name] | Create new project from template |
| /review [scope] | Comprehensive code review |
| /test [scope] | Run and generate tests |
| /deploy [target] | Local deployment |
| /pr [base-branch] | Create PR with review summary |
| /diagnose [issue] | Debug an issue |
| /secure | Security audit |
| /status | Project health check |
| /migrate [from] [to] | Technology migration |
