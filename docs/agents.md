# Agent Catalog

## Overview

19 specialized agents organized in 5 categories. The main Claude conversation orchestrates them — subagents cannot spawn other subagents.

## Model Tiers

| Tier | Model | Use Case |
|------|-------|----------|
| Critical | opus | Judgment-heavy: planning, review, security, API design |
| Workhorse | inherit | Implementation: uses session's active model |
| Standard | sonnet | Structured tasks: testing, debugging, CI/CD, docs, infra |
| Fast | haiku | Scanning and lookups: scout, dependency checks |

## Agents

### Reconnaissance

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| pm | sonnet | 10 | Request classification, dispatch planning |
| scout | haiku | 15 | Project scanning, tech stack detection |
| strategist | opus | 25 | Strategic evaluation, feasibility, build-vs-buy |
| planner | opus | 30 | Architecture decisions, task decomposition |

### Implementation

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| coder | inherit | 50 | General-purpose code implementation |
| coder-frontend | inherit | 50 | UI, components, styling, client-side logic |
| coder-backend | inherit | 50 | APIs, database, auth, middleware |
| coder-mobile | inherit | 50 | Mobile-specific: platform code, device APIs |

### Quality

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| tester | sonnet | 40 | Test writing, execution, coverage |
| reviewer | opus | 30 | Code review (read-only) |
| security-auditor | opus | 25 | Security analysis (read-only) |

### Operations

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| debugger | sonnet | 40 | Bug investigation and fixing |
| performance | sonnet | 25 | Performance analysis (primarily read-only) |
| ci-cd | sonnet | 30 | CI/CD pipeline creation and maintenance |

### Support

| Agent | Model | Max Turns | Purpose |
|-------|-------|-----------|---------|
| documenter | sonnet | 20 | Technical documentation |
| api-designer | opus | 25 | API design, OpenAPI specs |
| dependency-manager | haiku | 15 | Dependency updates, vulnerability scanning |
| tracker | haiku | 10 | Work item tracking across sessions |
| coder-infra | sonnet | 30 | Docker, compose, nginx, infrastructure |

## Usage

Agents are invoked via the Task tool from the main conversation:

```
Task(subagent_type="scout", model="haiku", prompt="Scan /path/to/project...")
Task(subagent_type="coder", prompt="Implement feature X based on this plan...")
```

Read-only agents (reviewer, security-auditor, performance, strategist, pm) do not modify files — except strategist can write decision documents to `docs/`. Implementation agents (coder-*) have file write access.
