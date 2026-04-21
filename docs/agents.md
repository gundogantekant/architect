# Agent Catalog

## Overview

33 specialized agents organized in 7 categories. The main Claude conversation orchestrates them — subagents cannot spawn other subagents.

## Model Tiers

| Tier | Model | Use Case |
|------|-------|----------|
| Critical | opus | Judgment-heavy: planning, review, security, API design |
| Workhorse | sonnet | Implementation: coder agents use sonnet |
| Standard | sonnet | Structured tasks: testing, debugging, CI/CD, docs, infra |
| Fast | haiku | Scanning and lookups: scout, dependency checks |

## Agents

### Reconnaissance

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| classifier | haiku | 5 | Fast request triage |
| coordinator | sonnet | 15 | Detailed dispatch planning |
| scout | haiku | 15 | Project scanning, tech stack detection |
| strategist | opus | 25 | Strategic evaluation, feasibility, build-vs-buy |
| planner | opus | 30 | Architecture decisions, task decomposition |

### Implementation

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| coder | sonnet | 50 | General-purpose code implementation |
| coder-frontend | sonnet | 50 | UI, components, styling, client-side logic |
| coder-backend | sonnet | 50 | APIs, database, auth, middleware |
| coder-mobile | sonnet | 50 | Mobile-specific: platform code, device APIs |
| refactorer | sonnet | 40 | Systematic code transformations |

### Quality

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| tester | sonnet | 40 | Test writing, execution, coverage |
| reviewer | opus | 30 | Code review (read-only) |
| security-auditor | opus | 25 | Security analysis (read-only) |

### Review Board

Context-filtered board of 3–10 agents that evaluate plans, code diffs, and PRs from multiple perspectives. Operates as a two-gate lifecycle (plan gate → `ready`, code gate → `done`). See `domain/rules.md` → Review Board Rules.

**Required (always dispatched)**:

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| tech-reviewer-swe | sonnet | 15 | Clean Code enforcement, testability, performance, security (read-only) |
| tech-reviewer-arch | sonnet | 15 | Clean Architecture enforcement, layer boundaries, structural soundness (read-only) |
| tech-reviewer-pm | sonnet | 15 | Scope alignment, risk, milestone impact, dependency tracking (read-only) |

**Context-dependent**:

| Agent | Model | Max Turns | Purpose | Dispatch when |
|-------|-------|-----------|---------|---------------|
| tech-reviewer-frontend | sonnet | 15 | Component architecture, state, rendering, accessibility (read-only) | Frontend stack or UI code |
| tech-reviewer-ux | sonnet | 15 | User flows, interaction design, accessibility, cognitive load (read-only) | User-facing interfaces |
| tech-reviewer-dx | sonnet | 15 | API surface, CLI ergonomics, Clean Code naming on APIs (read-only) | Developer-facing surfaces |
| tech-reviewer-dba | sonnet | 15 | Schema design, queries, migrations, Clean Architecture data layer (read-only) | Database usage |
| tech-reviewer-systems | sonnet | 15 | System boundaries, protocols, cross-subsystem failure modes (read-only) | Multi-subsystem projects |
| tech-reviewer-iot | sonnet | 15 | Device provisioning, OTA, telemetry, BLE, power management (read-only) | IoT/embedded projects |

### Operations

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| debugger | sonnet | 40 | Bug investigation and fixing |
| performance | sonnet | 25 | Performance analysis (primarily read-only) |
| ci-cd | sonnet | 30 | CI/CD pipeline creation and maintenance |
| git-ops | haiku | 10 | Git operations (branching, merging, worktrees) |

### Support

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| documenter | sonnet | 20 | Technical documentation |
| api-designer | opus | 25 | API design, OpenAPI specs |
| dependency-manager | haiku | 15 | Dependency updates, vulnerability scanning |
| tracker | haiku | 10 | Work item tracking across sessions |
| coder-infra | sonnet | 30 | Docker, compose, nginx, infrastructure |

### Browser

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| browser | sonnet | 30 | Browser automation via Playwright MCP (E2E, visual, web tasks) |

## Usage

Agents are invoked via the Task tool from the main conversation:

```
Task(subagent_type="scout", model="haiku", prompt="Scan /path/to/project...")
Task(subagent_type="coder", prompt="Implement feature X based on this plan...")
```

Read-only agents (reviewer, security-auditor, performance, strategist, classifier, coordinator, tech-reviewer-*) do not modify files — except strategist can write decision documents to `docs/`. The browser agent is interactive (web actions via Playwright) but does not modify code or data files. Implementation agents (coder-*) have file write access.
