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
**Data-write agents**: tracker (writes only `work/backlog.json`)

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
  "target_project": "string (org/project/component from portfolio, or absolute path if not onboarded)",
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
  "custom_rules": ["string"]
}
```

**Optional fields**: `brief` and `doc_paths` are absent on entries onboarded before the profiler was added.

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
  "projects": ["string"]
}
```

## WorkItem

Stored in `work/backlog.json` under `projects[key].items`. The project key (`org/project/component`) provides the project context, so items do not carry a redundant `project` field.

```json
{
  "id": "string (W-XXX format, zero-padded)",
  "title": "string",
  "status": "open|in-progress|blocked|done|cancelled",
  "priority": "low|medium|high|critical",
  "description": "string",
  "created": "YYYY-MM-DD",
  "updated": "YYYY-MM-DD",
  "blocked_by": "string (W-XXX or empty)",
  "tags": ["string"],
  "session_log": [
    { "date": "YYYY-MM-DD", "summary": "string" }
  ]
}
```

## WorkBacklog

Top-level structure of `work/backlog.json`. Items are grouped under project keys.

```json
{
  "version": 2,
  "next_id": "number",
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
  "branch_name": "string"
}
```

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
