# Architecture Blueprint

Ten Mermaid diagrams providing a visual reference for the architect system.

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

## 5. ER Diagrams

Key PostgreSQL tables and their relationships. Split into three focused sub-sections for readability. Schema derived from migration files 001–023.

### 5a. Core Work Entities

```mermaid
erDiagram
  projects {
    text key PK
    text org
    text project
    text component
    text path
    text role
    timestamptz synced_at
  }

  work_items {
    text id PK
    text project_key
    text epic_id
    text title
    text status
    text priority
    text description
    jsonb depends_on
    jsonb tags
    boolean input_needed
    boolean approval_active
    text approval_mode
    timestamptz done_at
    timestamptz created_at
    timestamptz updated_at
  }

  work_item_logs {
    bigint id PK
    text work_item_id FK
    timestamptz logged_at
    text summary
  }

  work_item_approvals {
    bigint id PK
    text work_item_id FK
    text identity
    text status
    integer sort_order
    text blocking_work_item_id
    timestamptz decided_at
  }

  epics {
    text id PK
    text title
    text status
    text priority
    text description
    text target_date
    timestamptz created_at
    timestamptz updated_at
  }

  epic_logs {
    bigint id PK
    text epic_id FK
    timestamptz logged_at
    text summary
  }

  %% work_items.project_key — no physical FK constraint to projects
  %% work_items.epic_id — logical FK only (nullable TEXT, no physical constraint)
  projects ||--o{ work_items : "has (logical)"
  epics ||--o{ work_items : "groups (logical)"
  work_items ||--o{ work_item_logs : "logs"
  work_items ||--o{ work_item_approvals : "approvals"
  epics ||--o{ epic_logs : "logs"
```

### 5b. Session Entities

```mermaid
erDiagram
  dispatches {
    text id PK
    text work_item_id
    text epic_id
    text project_key
    text org_key
    text title
    text status
    text agent_phase
    text pipeline_stage
    text dispatch_mode
    text permission_mode
    boolean skip_permissions
    integer pid
    real cost_usd
    text worktree_path
    text worktree_branch
    text source_branch
    boolean plan_gate_passed
    boolean code_gate_passed
    boolean contract_satisfied
    text merge_result
    text completion_sha
    jsonb contract
    timestamptz timeout_at
    timestamptz started_at
    timestamptz completed_at
  }

  terminals {
    text id PK
    text type
    text work_item_id
    text project_key
    text org_key
    text title
    text status
    text permission_mode
    boolean skip_permissions
    integer pid
    text tmux_session
    text agent_type
    timestamptz started_at
    timestamptz exited_at
  }

  cli_sessions {
    text id PK
    text project_key
    text work_item_id
    text title
    integer pid
    text status
    timestamptz registered_at
    timestamptz exited_at
  }

  session_history {
    text id PK
    text type
    text project_key FK
    text work_item_id
    text title
    text status
    real cost_usd
    timestamptz started_at
    timestamptz ended_at
    real duration_seconds
  }

  %% dispatches.work_item_id, dispatches.epic_id — logical FKs only (no physical constraint)
  %% terminals.project_key, cli_sessions.project_key — no physical FK constraint
  session_history }o--|| projects : "project_key (physical FK)"
```

### 5c. Knowledge and Sync Entities

```mermaid
erDiagram
  knowledge_syncs {
    bigint id PK
    text project_key
    text trigger
    text status
    timestamptz started_at
    timestamptz synced_at
    text commit_from
    text commit_to
    integer commits_scanned
    integer significant_count
    text sync_source
    text error
  }

  change_log_entries {
    bigint id PK
    text project_key
    text commit_hash
    text commit_message
    text author
    timestamptz committed_at
    text classification
    text ai_summary
    timestamptz detected_at
  }

  repo_sync_config {
    text github_repo_name PK
    text github_org
    text default_branch
    text local_path
    text portfolio_key
    boolean sync_enabled
    timestamptz last_github_updated_at
    timestamptz created_at
    timestamptz updated_at
  }

  adrs {
    text id PK
    text org_key
    text title
    text type
    jsonb repos
    text sync_run_id
    text detail_path
    timestamptz created_at
  }

  sequences {
    text name PK
    bigint next_val
  }

  preferences {
    text key PK
    text value
  }

  %% adrs uses org_key — NOT linked to projects table (no project_key FK)
  %% knowledge_syncs.project_key, change_log_entries.project_key — no physical FK constraint
```

---

## 6. Skills to Agents

Primary dispatch relationships from skills to the agents they invoke.

```mermaid
graph LR
  subgraph Skills
    sk_implement["/implement"]
    sk_review["/review"]
    sk_refactor["/refactor"]
    sk_secure["/secure"]
    sk_test["/test"]
    sk_onboard["/onboard"]
    sk_pr["/pr"]
    sk_deploy["/deploy"]
    sk_diagnose["/diagnose"]
    sk_explain["/explain"]
    sk_release["/release"]
    sk_migrate["/migrate"]
    sk_browse["/browse"]
    sk_status["/status"]
  end

  subgraph Orchestration
    classifier
    coordinator
  end

  subgraph Planning
    planner
    strategist
  end

  subgraph Implementation
    coder
    coder-backend["coder-backend"]
    coder-frontend["coder-frontend"]
    coder-infra["coder-infra"]
    coder-mobile["coder-mobile"]
    refactorer
  end

  subgraph Quality
    tester
    reviewer
  end

  subgraph Analysis
    scout
    debugger
    profiler
    security-auditor["security-auditor"]
    dependency-manager["dependency-manager"]
    performance
  end

  subgraph ReviewBoard["Tech Review Board"]
    tech-reviewers["tech-reviewers\n(3-10 context-filtered)\nswe·arch·pm·dx·frontend·ux·dba·systems·iot·prod"]
  end

  subgraph Workflow
    git-ops["git-ops"]
    ci-cd["ci-cd"]
    documenter
    tracker
    browser
    api-designer["api-designer"]
  end

  sk_implement --> coder
  sk_implement --> tester
  sk_implement --> tech-reviewers
  sk_implement --> git-ops
  sk_implement --> tracker

  sk_review --> reviewer
  sk_review --> tech-reviewers

  sk_refactor --> planner
  sk_refactor --> refactorer
  sk_refactor --> tester
  sk_refactor --> reviewer

  sk_secure --> security-auditor
  sk_secure --> dependency-manager

  sk_test --> tester
  sk_test --> scout

  sk_onboard --> scout
  sk_onboard --> profiler

  sk_pr --> reviewer
  sk_pr --> git-ops

  sk_deploy --> coder-infra
  sk_deploy --> scout

  sk_diagnose --> debugger
  sk_diagnose --> coder
  sk_diagnose --> tester

  sk_explain --> scout
  sk_explain --> documenter

  sk_release --> documenter
  sk_release --> coder
  sk_release --> ci-cd

  sk_migrate --> planner
  sk_migrate --> coder
  sk_migrate --> tester
  sk_migrate --> reviewer

  sk_browse --> browser

  sk_status --> dependency-manager
  sk_status --> scout
```

---

## 7. Dispatch State Machines

### 7a. Dispatch Session Lifecycle

```mermaid
stateDiagram-v2
    [*] --> running : POST /api/dispatch
    running --> completed : process exit(0)
    running --> failed : exit(non-0) or timeout
    running --> killed : POST /kill
    running --> interrupted : PID died unexpectedly
    running --> suspended : POST /suspend
    running --> merge_pending : POST /complete (auto_implement mode)
    suspended --> running : POST /resume
    merge_pending --> completed : POST /merge (success)
    merge_pending --> merge_conflict : POST /merge (conflict)
    completed --> [*]
    failed --> [*]
    killed --> [*]
    interrupted --> [*]
    merge_conflict --> [*]
```

### 7b. Agent Phase

`agent_phase` is non-null only when `dispatch.status = 'running'`. Terminal dispatch statuses imply `agent_phase = null`. Persisted to `dispatches.agent_phase` column since W-987 (migration 019). Transitions derived from `derivePhase()` in `dispatch-manager.mjs`.

```mermaid
stateDiagram-v2
    [*] --> generating : first stream-json event
    generating --> tool_running : content_block_start(tool_use)\nor stop_reason=tool_use
    tool_running --> generating : content_block_start(text)\nor content_block_delta(text)
    tool_running --> waiting_for_input : stop_reason=end_turn
    waiting_for_input --> generating : new turn begins
    generating --> [*] : evt.type=result
    tool_running --> [*] : dispatch terminal
    waiting_for_input --> [*] : dispatch terminal

    note right of waiting_for_input
        Bridges to work_items.input_needed=true
        via agent_phase_bridge in dispatch-manager.mjs
    end note
```

---

## 8. Portfolio Hierarchy

```mermaid
graph TD
    Root["~/.architect/portfolio/"]
    Registry["registry.json\n(key to path lookup)"]
    Root --> Registry

    Root --> neuronic["neuronic/"]
    neuronic --> neuronic_org["organization.json"]
    neuronic --> neuronic_proj1["cloud/main.json"]
    neuronic --> neuronic_proj2["firmware/main.json"]
    neuronic --> neuronic_dotdotdot["... (11 projects total)"]

    Root --> ticari["ticari/"]
    ticari --> ticari_org["organization.json"]
    ticari --> ticari_arch["architect/main.json"]
    ticari --> ticari_other["is-arama/main.json\nlongevity/main.json\nsecond-brain/main.json"]

    Root --> testorg["testorg/"]
    testorg --> testorg_proj["testproj/main.json"]
```

Portfolio files store full project profiles (stack, structure, guides, agent context). The `registry.json` maps project keys (`org/project/component`) to absolute file paths. Organization JSON holds shared conventions. Component JSON holds the full `ProjectBrief` and scout report.

---

## 9. Domain Entities Cross-check Summary

Confirmed drift between `entities.md` definitions and actual PostgreSQL migrations or source code. Scope limited to entities with both a domain schema and a DB representation.

| Entity | Aspect | entities.md (stale) | Actual source | Status |
|--------|--------|---------------------|---------------|--------|
| AgentPhase | description | "Ephemeral (in-memory only, not persisted to PostgreSQL)" | Persisted to `dispatches.agent_phase` + `agent_phase_history` since W-987 (migration 019) | Fixed in entities.md |
| AgentPhase | values | includes `worktree_setup` | `worktree_setup` is never emitted by `derivePhase()`; it is a PIPELINE_STAGES value (constants.mjs), set pre-spawn, not an agent phase | Fixed in entities.md |
| adrs | columns | project_key FK, number, status, author, source_work_item | org_key, type (TEXT), repos (JSONB), sync_run_id, detail_path — migration 017 | Corrected in ER diagram |
| adrs | id PK type | integer | TEXT — migration 017 | Corrected in ER diagram |
| repo_sync_configs | table name | repo_sync_configs (plural) | repo_sync_config (singular) — migration 015 | Corrected in ER diagram |
| work_items | approval column | approval (JSON) | No approval JSON column; approval tracked via work_item_approvals table and boolean approval_active field — migration 001 | Corrected in ER diagram |
| dispatches | columns | missing contract, timeout_at, agent_phase_history, contract_satisfied | All added by migrations 019–022 | Corrected in ER diagram |
| work_items | missing column | done_at absent | done_at TIMESTAMPTZ added by migration 023 | Corrected in ER diagram — flagged, not fixed in entities.md |

---

## 10. Two-Gate Lifecycle

Two-gate work item lifecycle: `open → [Plan Gate] → ready → in-progress → [Code Gate] → done`. The Plan Gate runs after the planner produces a plan; the Code Gate runs after tests pass, before commit. Both gates are read-only Review Board dispatches. Claude Code plan mode is an outer harness layer and does not substitute for either gate.

```mermaid
flowchart TB
    User([User])

    subgraph CCMode["Claude Code harness mode (outer)"]
        direction TB
        PlanMode["Plan Mode<br/>(read-only, writes plan file)"]
        ImplMode["Implementation Mode<br/>(writes allowed)"]
    end

    subgraph Skill["Architect Skill (e.g., /implement)"]
        direction TB
        S1[Resolve target + load portfolio]
        S2[Planner produces plan]
        PG{{"Plan Gate<br/>Review Board + user approval"}}
        S3[Coder + Tester]
        CG{{"Code Gate<br/>Review Board + reviewer"}}
        S4[git-ops commit / PR]
    end

    User -->|toggles| CCMode
    User -->|invokes skill| Skill
    PlanMode -.->|blocks writes inside skill| Skill
    ImplMode -->|allows skill to complete| Skill

    S1 --> S2 --> PG
    PG -->|approve| S3
    PG -->|block| S2
    S3 --> CG
    CG -->|approve| S4
    CG -->|block| S3

    classDef gate fill:#fff3cd,stroke:#8a6d3b,color:#000
    class PG,CG gate
```

Source: `domain/rules.md` → Review Board Rules (Plan Gate / Code Gate triggers in `usecases/implement-work-item.md` steps 6 and 11).
