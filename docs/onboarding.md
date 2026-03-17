# Onboarding Projects

## Quick Start

```
/onboard /path/to/your/project
```

Scans the project, analyzes its purpose and architecture, generates a CLAUDE.md, and registers it in the architect portfolio.

## What Happens

1. **Registry check** — looks up the path in `portfolio/registry.json`
2. **Organization detection** — auto-associates if path is under a known org's `path_root`
3. **Scout scan** — detects language, framework, CI/CD, testing, dependencies
4. **Profiler analysis** — reads README, docs, and source to produce a project brief, documentation map, and CLAUDE.md
5. **Agent recommendation** — selects relevant agents based on the stack
6. **Profile creation** — writes `portfolio/<org>/<project>/<component>.json`
7. **Registry update** — adds the path mapping to `portfolio/registry.json`

A `CLAUDE.md` file is written to the target project root. No other files are modified.

## Arguments

| Argument | Required | Description |
|----------|----------|-------------|
| `path` | yes | Absolute path to the project |
| `--organization <name>` | no | Override auto-detected org |
| `rescan` | no | Refresh an existing profile's scout report |

## Examples

```
/onboard /path/to/project
/onboard /path/to/project --organization myorg
/onboard /path/to/project rescan
```

## Project Brief

The profiler agent reads the project's README, documentation, package manifests, and source structure to produce a `ProjectBrief` containing:

- **purpose** — what the system does
- **domain** — business/product domain
- **users** — who uses the system
- **key_entities** — core domain objects
- **data_flow** — high-level data movement
- **architecture_rationale** — why the stack was chosen
- **constraints** — hard non-negotiables (compliance, SLAs)
- **environments** — deployment targets
- **external_dependencies** — third-party services

The brief is stored in the portfolio entry and loaded by agents at the standard and full context tiers.

## CLAUDE.md Generation

The profiler generates a `CLAUDE.md` in the target project root containing:

- Project overview (purpose, domain, users)
- Tech stack summary
- Directory structure with descriptions
- Key conventions
- Build/run/test commands
- Architecture notes
- Constraints

### Existing CLAUDE.md

If the target project already has a CLAUDE.md:

1. The profiler reads it and incorporates its content into the ProjectBrief
2. You are asked to choose: **merge** (combine existing + generated), **overwrite** (replace), or **skip** (keep existing)

## Documentation Map

The profiler collects relative paths to all documentation files found (README, docs/, CONTRIBUTING.md, etc.) and stores them as `doc_paths` in the portfolio entry. Agents can read these files on demand when they need deeper context.

## Rescanning

Running `/onboard <path> rescan` on an already-registered project:
- Runs scout again to refresh the detection report
- Runs profiler again to refresh the brief and doc_paths
- Asks before overwriting an existing CLAUDE.md
- Preserves `custom_rules` and `guidance`

## Organization Auto-Detection

During onboard, if the project path starts with an existing org's `path_root` or `path_alias`, the org is auto-associated. Override with `--organization <name>`.

If no org matches, you can create a new one or onboard without org association.

## What Gets Detected

- **Language**: TypeScript, Dart, Python, Go, Rust, C/C++
- **Framework**: React, Flutter, NestJS, FastAPI, Next.js, Express, ESP-IDF
- **Mobile**: Flutter, Expo, React Native
- **CI/CD**: GitHub Actions, Forgejo Actions
- **Containers**: Docker, Podman
- **Database**: PostgreSQL, SQLite, MongoDB, Firestore
- **Testing**: Jest, Vitest, Pytest, Flutter Test, Maestro
- **Package Manager**: npm, yarn, pnpm, bun, pub, pip, cargo

## Post-Onboard

After onboarding, all skills automatically load the project's portfolio context as their first step. Run `/portfolio list` to verify registration.
