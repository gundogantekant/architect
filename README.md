# Architect

**22 AI agents. 17 slash commands. One SDLC.**

A complete software development lifecycle system built on [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Architect gives you specialized agents for every phase of development — from triage to deployment — orchestrated through simple slash commands, with persistent context across projects and sessions.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Built for Claude Code](https://img.shields.io/badge/Built%20for-Claude%20Code-blueviolet)]()
[![Platform](https://img.shields.io/badge/Platform-macOS%20%7C%20Linux-lightgrey)]()

## Why Architect

| Capability | Bare Claude Code | With Architect |
|-----------|-----------------|----------------|
| **Project context** | Re-explain your stack every session | `/onboard` once, context loads automatically |
| **Persistence** | Work items lost between sessions | Backlog, epics, and dependencies survive restarts |
| **Workflows** | Manual prompt chaining | Pre-built pipelines: scout → plan → code → test → review |
| **Multi-project** | One project at a time | Portfolio registry with org/project/component hierarchy |
| **Orchestration** | Single agent, single task | 22 specialized agents with parallel fan-out |

## Quick Start

```bash
# 1. Clone into your Claude Code config
git clone https://github.com/gundogantekant/architect.git ~/.claude/architect

# 2. No dependencies to install — zero npm install, zero build step.
#    Architect is prompt-driven. The only runtime dependency is Claude Code itself.

# 3. Onboard your first project
/onboard ~/your-project

# 4. Start using commands
/work add "Implement user authentication"   # track work
/review                                      # code review
/test                                        # run and generate tests
/diagnose "login timeout on staging"         # debug an issue
```

## Architecture

Clean Architecture with four layers. Dependencies point inward only.

```
┌──────────────────────────────────────────┐
│  Infrastructure                          │
│  portfolio/, work/, templates/           │  Instance data, project templates
├──────────────────────────────────────────┤
│  Adapters                                │
│  .claude/agents/, .claude/skills/        │  Agent prompts, skill entry points
├──────────────────────────────────────────┤
│  Use Cases                               │
│  usecases/                               │  Workflow definitions (17 files)
├──────────────────────────────────────────┤
│  Domain                                  │
│  domain/                                 │  Entity schemas, business rules
└──────────────────────────────────────────┘
```

- **Domain** defines what exists (entities, schemas) and what's allowed (business rules)
- **Use Cases** define how workflows execute, referencing only the domain
- **Adapters** translate use cases into Claude Code agents and slash commands
- **Infrastructure** stores instance data — portfolios, work items, templates

## Agents

Model key: **O** = Opus, **S** = Sonnet, **H** = Haiku, **I** = Inherit (caller's model)

| Agent | Category | Model | Purpose |
|-------|----------|-------|---------|
| pm | Orchestration | S | Triage requests and produce dispatch plans |
| scout | Discovery | H | Scan a project's tech stack and structure |
| profiler | Discovery | S | Deep project analysis and CLAUDE.md generation |
| strategist | Planning | O | Strategic evaluation of complex requests |
| planner | Planning | O | Architecture and design decisions |
| coder | Implementation | I | General-purpose code implementation |
| coder-frontend | Implementation | I | Frontend and UI work |
| coder-backend | Implementation | I | Backend and API work |
| coder-mobile | Implementation | I | Mobile development |
| coder-infra | Implementation | S | Infrastructure and DevOps |
| tester | Quality | S | Write and run tests |
| reviewer | Quality | S | Code review (read-only) |
| security-auditor | Quality | O | Security audit (read-only) |
| debugger | Investigation | S | Bug investigation and root cause analysis |
| performance | Investigation | S | Performance profiling and optimization (read-only) |
| ci-cd | Automation | S | CI/CD pipeline configuration |
| documenter | Documentation | S | Technical documentation |
| api-designer | Design | S | API design and schema definition |
| dependency-manager | Maintenance | H | Dependency updates and compatibility (read-only) |
| tracker | Tracking | H | Work item and backlog management |
| refactorer | Implementation | S | Systematic, scoped refactoring |
| browser | Automation | S | Browser automation via Playwright (E2E, visual, web) |

## Commands

### Setup

| Command | Purpose |
|---------|---------|
| `/onboard [path] [--organization org] [rescan]` | Scan and register a project in the portfolio |
| `/portfolio [list\|show\|remove]` | View and manage registered projects |
| `/scaffold [type] [name]` | Create a new project from a template |
| `/worktree [list\|cleanup]` | Manage git worktrees for implementation isolation |

### Development

| Command | Purpose |
|---------|---------|
| `/work [subcommand] [args]` | Track work items, epics, and dependencies |
| `/diagnose [issue]` | Debug an issue with log analysis and tracing |
| `/explain [path] [--focus area]` | Codebase walkthrough for onboarding |
| `/migrate [from] [to]` | Technology migration assistance |
| `/refactor [scope]` | Systematic refactoring with verification |
| `/browse [task]` | Browser automation via Playwright |

### Quality & Release

| Command | Purpose |
|---------|---------|
| `/review [scope]` | Code review of staged changes, branch diff, or files |
| `/test [scope]` | Run existing tests and generate missing ones |
| `/secure` | Security audit |
| `/status` | Project health: deps, coverage, TODOs, CI |
| `/pr [base-branch]` | Create a PR with review summary |
| `/release [version] [--publish github]` | Version bump, changelog, git tag |
| `/deploy [target]` | Local deployment via Docker Compose or Podman |

## Workflow Patterns

Architect orchestrates agents in four patterns. The main Claude session acts as the coordinator — subagents do not spawn subagents.

```
Sequential Pipeline (new features)
  scout → strategist → planner → coder → tester → reviewer

Parallel Fan-Out (full-stack features)
  ┌→ coder-frontend ─┐
  ├→ coder-backend  ──┤→ tester → reviewer
  └→ coder-infra    ──┘

Plan-Then-Execute (large features)
  planner (task list) → dispatch coders per task → tester → reviewer

Investigate-Then-Fix (bugs)
  debugger → coder (fix) → tester (verify)
```

For the full workflow selection matrix and PM dispatch rules, see [docs/workflows.md](docs/workflows.md).

## Portfolio

Projects are onboarded into a local portfolio with org/project/component hierarchy:

```
portfolio/
├── registry.json                          # path → portfolio location lookup
├── acme/                                  # organization
│   ├── organization.json                  # org-level conventions
│   └── web-app/                           # project
│       ├── frontend.json                  # component profile
│       └── backend.json
```

- Context loads automatically at the start of every skill invocation
- Organization-level conventions cascade to all projects beneath
- Component profiles include tech stack, conventions, and agent guidance
- `/onboard <path> rescan` refreshes stale profiles

## Work Tracking

Persistent backlog that survives across sessions:

```bash
/work add "Implement OAuth flow"           # create a work item
/work list                                 # view open items
/work epic create "Q1 Auth Overhaul"       # group items into epics
/work depend W-003 W-001                   # declare dependencies
```

- Work items keyed by project (`org/project/component`) with globally unique IDs (`W-XXX`)
- Epics (`E-XXX`) for cross-project strategic grouping
- Multi-dependency tracking with cycle detection
- Dashboard integration for visual management and agent dispatch

## Dashboard

Local web dashboard for portfolio and work item management:

```bash
node tools/dashboard/server.mjs            # starts at http://127.0.0.1:3777

# Or use dashctl.sh for lifecycle management
./tools/dashboard/dashctl.sh start         # background start with PID tracking
./tools/dashboard/dashctl.sh stop          # graceful shutdown
./tools/dashboard/dashctl.sh restart       # stop + start
./tools/dashboard/dashctl.sh status        # PID, port, uptime, health check
./tools/dashboard/dashctl.sh fresh --clear-sessions  # clean restart
./tools/dashboard/dashctl.sh install       # auto-start on login (launchd/systemd)
./tools/dashboard/dashctl.sh uninstall     # remove auto-start service
./tools/dashboard/dashctl.sh logs -f       # follow server logs
```

- Portfolio browser with component-level detail
- Work item board with epic grouping
- Agent dispatch directly from work items (spawns Claude Code subprocesses)
- Live output streaming via SSE with concurrent dispatch support
- Interactive terminals with bidirectional PTY I/O
- Session persistence across server restarts
- Settings page (`#settings`) for server status, restart/stop, and auto-start configuration
- Auto-start support via launchd (macOS) and systemd (Linux)

## Templates

Scaffold new projects with built-in templates:

| Template | Stack |
|----------|-------|
| `frontend-react` | React + Vite + TypeScript |
| `backend-ts` | Node.js + TypeScript + Express |
| `fullstack` | React frontend + Node backend |
| `mobile-expo` | Expo + React Native + TypeScript |
| `infra` | Terraform + Docker |
| `ci` | GitHub Actions workflows |

```bash
/scaffold frontend-react my-app
/scaffold fullstack my-saas --organization acme
```

## Contributing

Architect is designed to be extended. Each contribution type is a markdown or JSON file — no compilation, no bundling.

- **Agents** — add a `.md` file to `.claude/agents/` defining the agent's role, model, and prompt
- **Templates** — add a directory under `templates/` with the project scaffold
- **Dashboard** — the UI is a single `index.html` + `server.mjs` in `tools/dashboard/`
- **Workflows** — add a use case file in `usecases/` following the existing pattern
- **Documentation** — improve or add guides in `docs/`

## Project Structure

```
architect/
├── .claude/
│   ├── agents/          # 22 agent prompt files
│   └── skills/          # 17 slash command definitions
├── domain/
│   ├── entities.md      # canonical schemas
│   └── rules.md         # business rules
├── usecases/            # workflow definitions
├── docs/                # documentation
├── templates/           # project scaffolds
├── tools/
│   └── dashboard/       # web dashboard
├── portfolio/           # project profiles (gitignored)
├── work/                # backlog and epics (gitignored)
├── CLAUDE.md            # project instructions for Claude Code
├── LICENSE
└── README.md
```

## License

MIT License. See [LICENSE](LICENSE) for details.

Copyright (c) 2026 [Tekant Gundogan](https://github.com/gundogantekant)
