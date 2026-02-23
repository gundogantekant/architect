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

**Read-only agents**: reviewer, security-auditor, performance, strategist, pm, scout, debugger, dependency-manager, documenter
**Implementation agents**: coder, coder-frontend, coder-backend, coder-mobile, coder-infra, ci-cd, api-designer
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
  "classification": { "$ref": "RequestClassification" },
  "clarifications_needed": ["string"],
  "execution_plan": {
    "workflow": "$ref WorkflowPattern",
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

Stored in `work/backlog.json` items array.

```json
{
  "id": "string (W-XXX format, zero-padded)",
  "title": "string",
  "status": "open|in-progress|blocked|done|cancelled",
  "priority": "low|medium|high|critical",
  "project": "string (org/project/component)",
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

Top-level structure of `work/backlog.json`.

```json
{
  "version": 1,
  "items": [{ "$ref": "WorkItem" }],
  "next_id": "number"
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
