# Project Portfolio

Centralized registry of onboarded projects. All project context (scout reports, agent recommendations, conventions) lives in the architect repo under `portfolio/`.

## Structure

```
portfolio/
├── registry.json                    # path → {org, project, component} lookup
└── <org>/                           # organization directory
    ├── organization.json            # shared org conventions
    └── <project>/
        └── <component>.json         # component profile
```

## Commands

| Command | Purpose |
|---------|---------|
| `/portfolio` or `/portfolio list` | Show all registered projects |
| `/portfolio show <org/project/component>` | Display full component profile |
| `/portfolio remove <org/project/component>` | Unregister a component |
| `/onboard <path>` | Register a new project |
| `/onboard <path> rescan` | Refresh an existing profile |

## Schemas

### registry.json

Maps absolute filesystem paths to portfolio coordinates.

```json
{
  "version": 1,
  "entries": {
    "/absolute/path/to/repo": {
      "org": "org-name",
      "project": "project-name",
      "component": "component-name"
    }
  }
}
```

### organization.json

Org-level conventions shared across all projects.

```json
{
  "name": "Org Display Name",
  "path_root": "/absolute/path/to/org/repos",
  "conventions": {
    "branch_prefix": "PREFIX-",
    "pr_title_pattern": "PREFIX-#### description"
  },
  "rules": ["Org-wide rules applied to all projects"],
  "projects": ["project-a", "project-b"]
}
```

### Component Profile (<component>.json)

Full onboarded repo context used by all skills and agents.

```json
{
  "name": "Display Name",
  "path": "/absolute/path/to/repo",
  "role": "mobile-frontend|backend|firmware|desktop",
  "onboarded_at": "YYYY-MM-DD",
  "last_scanned": "YYYY-MM-DD",
  "scout_report": { },
  "brief": {
    "purpose": "One sentence: what the system does",
    "domain": "business-domain",
    "users": "Who uses the system and how",
    "key_entities": ["Entity1", "Entity2"],
    "data_flow": "Client → API → Database",
    "architecture_rationale": "Why the stack was chosen",
    "constraints": ["Constraint1"],
    "environments": ["production: AWS us-east-1"],
    "external_dependencies": ["Stripe", "AWS S3"],
    "profiled_at": "YYYY-MM-DD"
  },
  "doc_paths": ["README.md", "docs/architecture.md", "CONTRIBUTING.md"],
  "agents": {
    "recommended": ["agent-list"],
    "dispatch_notes": { "agent": "usage note" }
  },
  "guidance": {
    "stack_summary": "...",
    "structure": ["dir descriptions"],
    "conventions": ["project conventions"],
    "ci_cd": ["CI/CD pipeline details"],
    "testing": ["test commands and patterns"]
  },
  "custom_rules": [],
  "portfolio_guides": ["debug-guide.md", "setup-guide.md"]
}
```

`brief`, `doc_paths`, and `portfolio_guides` are optional — absent on entries onboarded before the profiler was added. `portfolio_guides` lists filenames of markdown guides in the same portfolio directory that are auto-loaded into agent context at standard tier and above.

## Context Loading

Every skill loads portfolio context as step 1:

1. Resolve target project path
2. Look up in `registry.json`
3. Read component profile + organization conventions
4. Pass combined context to agents
5. Fall back to inline scout if not in portfolio