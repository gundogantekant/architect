# Architecture Blueprint

Five Mermaid diagrams providing a visual reference for the architect system.

---

## 1. System Context

Top-level view of actors, systems, and their relationships.

```mermaid
C4Context
  title System Context — Architect SDLC Agent System

  Person(user, "User", "Developer using the system via browser or CLI")
  System_Ext(cli, "Claude Code CLI", "External tool; orchestrator session runs here")
  System(dashboard, "Dashboard Server", "Node.js HTTP + WebSocket server on port 3777")
  SystemDb(postgres, "PostgreSQL", "Work items, dispatches, sessions, epics, ADRs")
  System_Ext(claude_sub, "Claude subprocess", "Spawned per dispatch; executes agent prompt")
  System_Ext(git, "Git / Worktrees", "Local FS; feature branches and isolated worktrees")
  System_Ext(github, "GitHub", "Remote: PRs, reviews, CI runs")

  Rel(user, dashboard, "Views work items, dispatches agents", "HTTP / WebSocket")
  Rel(user, cli, "Issues commands, reviews output", "Terminal")
  Rel(cli, dashboard, "Reads backlog, posts dispatch, registers CLI session", "HTTP")
  Rel(dashboard, postgres, "Reads/writes all persistent state", "pg driver")
  Rel(dashboard, claude_sub, "Spawns, streams JSONL output", "node:child_process")
  Rel(claude_sub, git, "Creates worktrees, commits, merges", "git CLI")
  Rel(claude_sub, github, "Opens PRs, pushes branches", "gh CLI")
  Rel(cli, git, "Reads status/log; delegates writes to git-ops agent", "git CLI")
```

---

## 2. Container Diagram

What runs where and how containers relate.

```mermaid
C4Container
  title Container Diagram — Architect System

  Person(user, "User")

  Container(dashboard, "Dashboard Server", "Node.js / ESM", "HTTP + WebSocket server; serves UI, manages dispatches and sessions")
  ContainerDb(postgres, "PostgreSQL", "Docker", "Persistent storage for work items, dispatches, terminals, epics, ADRs")
  Container(portfolio, "Portfolio Store", "JSON files (~/.architect/portfolio/)", "Per-project profiles, org conventions, ADRs, registry")

  Container_Ext(domain, "Domain Layer", "Markdown (domain/)", "Entity schemas and business rules; read by agents at dispatch time")
  Container_Ext(usecases, "Use Cases Layer", "Markdown (usecases/)", "Workflow definitions; read by skills and agents")
  Container_Ext(agents, "Agent Prompts", "Markdown (.claude/agents/, .claude/skills/)", "34 specialized agent prompts; dispatched as Claude subprocesses")

  Rel(user, dashboard, "Browser / HTTP", "port 3777")
  Rel(dashboard, postgres, "pg driver", "SQL")
  Rel(dashboard, portfolio, "readFile / writeFile", "FS")
  Rel(dashboard, agents, "spawn claude -p", "subprocess")
  Rel(agents, domain, "references schemas + rules", "read-only")
  Rel(agents, usecases, "follows workflow steps", "read-only")
  Rel(agents, portfolio, "reads project context", "FS")
```

---

## 3. Component Diagram (Dashboard Container)

Internal structure of `tools/dashboard/`.

```mermaid
C4Component
  title Component Diagram — Dashboard Server

  Component(server, "server.mjs", "Entrypoint", "Registers all routes; starts HTTP + WebSocket server")
  Component(db, "db.mjs", "Data Access", "All PostgreSQL queries via pg driver")
  Component(state, "state.mjs", "In-memory State", "Maps for dispatches, terminals, cliSessions; saveDispatchToDb")
  Component(dispatch_mgr, "dispatch-manager.mjs", "Dispatch Orchestration", "Spawns Claude subprocess; wireDispatchHandlers; derivePhase; restoreSessions; attemptMerge")
  Component(prompt_builder, "prompt-builder.mjs", "Prompt Assembly", "Builds dispatch prompts from portfolio context, work item, and contract")
  Component(ws_router, "ws-router.mjs", "WebSocket", "Broadcasts live dispatch output to browser clients")
  Component(merge, "merge.mjs", "Merge Helper", "Git worktree merge; isMergeLocked guard")

  Component(r_work, "routes/work-items.mjs", "Route", "CRUD for work items, artifacts, approvals")
  Component(r_dispatch, "routes/dispatch.mjs", "Route", "POST /api/dispatch; stream SSE; kill; delete")
  Component(r_portfolio, "routes/portfolio.mjs", "Route", "Portfolio read/write endpoints")
  Component(r_sessions, "routes/sessions.mjs", "Route", "CLI session registration and liveness")
  Component(r_epics, "routes/epics.mjs", "Route", "Epic CRUD, linking, plan/doc")
  Component(r_terminals, "routes/terminal.mjs", "Route", "PTY terminal lifecycle + WebSocket")
  Component(r_repos, "routes/repos.mjs", "Route", "Repo sync config management")
  Component(r_adrs, "routes/adrs.mjs", "Route", "ADR CRUD per project")
  Component(frontend, "index.html", "SPA Frontend", "xterm.js + WebSocket; dispatch panels; work item views")

  Rel(server, r_work, "registers")
  Rel(server, r_dispatch, "registers")
  Rel(server, r_portfolio, "registers")
  Rel(server, r_sessions, "registers")
  Rel(server, r_epics, "registers")
  Rel(server, r_terminals, "registers")
  Rel(server, r_repos, "registers")
  Rel(server, r_adrs, "registers")
  Rel(server, ws_router, "setupWebSocket")

  Rel(r_dispatch, dispatch_mgr, "wireDispatchHandlers / spawn")
  Rel(r_dispatch, prompt_builder, "buildDispatchPrompt")
  Rel(r_dispatch, state, "dispatches map")
  Rel(dispatch_mgr, db, "upsert dispatch / cost")
  Rel(dispatch_mgr, ws_router, "broadcastDispatchLine")
  Rel(dispatch_mgr, merge, "attemptMerge on complete")
  Rel(r_work, db, "queries")
  Rel(r_epics, db, "queries")
  Rel(r_terminals, state, "terminals map")
  Rel(r_sessions, state, "cliSessions map")
  Rel(server, frontend, "GET / → index.html")
```

---

## 4. Data Flow — Dispatch Lifecycle

Sequence from POST /api/dispatch to session archive.

```mermaid
sequenceDiagram
  participant Browser
  participant Server as server.mjs / routes/dispatch.mjs
  participant PB as prompt-builder.mjs
  participant DM as dispatch-manager.mjs
  participant Claude as Claude subprocess
  participant WS as ws-router.mjs
  participant DB as PostgreSQL
  participant Merge as merge.mjs

  Browser->>Server: POST /api/dispatch (work_item_id, permission_mode, instructions)
  Server->>DB: validate contract (work item complexity check)
  Server->>PB: buildDispatchPrompt(portfolio context, work item, contract)
  PB-->>Server: assembled prompt string
  Server->>DM: wireDispatchHandlers(dispatch)
  DM->>Claude: spawn claude -p --output-format stream-json
  DM->>DB: INSERT dispatch (status=running, pid, worktree_path)

  loop JSONL event stream
    Claude-->>DM: stream JSONL event
    DM->>DM: derivePhase(event) → agent_phase
    DM->>WS: broadcastDispatchLine(dispatch, line)
    WS-->>Browser: WebSocket push (type: data)
    DM->>DB: UPDATE cost_usd, pipeline_stage (periodic)
  end

  Claude-->>DM: process exit
  DM->>DB: UPDATE status=completed|failed, completed_at, cost_usd
  DM->>Merge: attemptMerge(dispatch)
  Merge->>Merge: git merge worktree branch → source branch
  Merge-->>DM: merge_result (success|conflict|aborted)
  DM->>DB: UPDATE merge_result, worktree_path=null
  DM->>WS: broadcastDispatchDone(dispatch)
  WS-->>Browser: WebSocket push (type: done)
  DM->>DB: archiveSession → session_history INSERT
```

---

## 5. ER Diagram

Key PostgreSQL tables and their relationships.

```mermaid
erDiagram
  projects {
    string key PK
    string org
    string project
    string component
    string path
    string role
  }

  work_items {
    string id PK
    string project_key FK
    string epic_id FK
    string title
    string status
    string priority
    string description
    json depends_on
    json tags
    boolean input_needed
    json approval
    string released_version
    timestamp created_at
    timestamp updated_at
  }

  epics {
    string id PK
    string title
    string status
    string priority
    string description
    string target_date
    timestamp created_at
    timestamp updated_at
  }

  dispatches {
    string id PK
    string work_item_id FK
    string project_key FK
    string status
    string agent_phase
    string pipeline_stage
    float cost_usd
    string worktree_path
    string worktree_branch
    string source_branch
    string permission_mode
    boolean skip_permissions
    string completion_sha
    string merge_result
    boolean plan_gate_passed
    boolean code_gate_passed
    timestamp started_at
    timestamp completed_at
  }

  terminals {
    string id PK
    string work_item_id FK
    string project_key FK
    string title
    string status
    integer pid
    string tmux_session
    string permission_mode
    timestamp started_at
    timestamp exited_at
  }

  cli_sessions {
    string id PK
    string project_key FK
    string work_item_id FK
    string title
    integer pid
    string status
    timestamp registered_at
    timestamp exited_at
  }

  session_history {
    integer id PK
    string type
    string project_key FK
    float cost_usd
    timestamp ended_at
  }

  repo_sync_configs {
    string github_repo_name PK
    string github_org
    string default_branch
    string local_path
    string portfolio_key
    boolean sync_enabled
    timestamp last_github_updated_at
  }

  adrs {
    integer id PK
    string project_key FK
    string number
    string title
    string status
    string author
    string source_work_item
    timestamp created_at
  }

  projects ||--o{ work_items : "has"
  projects ||--o{ dispatches : "has"
  projects ||--o{ terminals : "has"
  projects ||--o{ cli_sessions : "has"
  projects ||--o{ session_history : "has"
  projects ||--o{ adrs : "has"
  epics ||--o{ work_items : "groups"
  work_items ||--o{ dispatches : "triggers"
  work_items ||--o{ terminals : "associated with"
```
