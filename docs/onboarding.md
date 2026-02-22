# Onboarding Projects

## Quick Start

```
/onboard /path/to/your/project
```

Scans the project, detects the tech stack, and registers it in the architect portfolio.

## What Happens

1. **Registry check** — looks up the path in `portfolio/registry.json`
2. **Organization detection** — auto-associates if path is under a known org's `path_root`
3. **Scout scan** — detects language, framework, CI/CD, testing, dependencies
4. **Agent recommendation** — selects relevant agents based on the stack
5. **Profile creation** — writes `portfolio/<org>/<project>/<component>.json`
6. **Registry update** — adds the path mapping to `portfolio/registry.json`

No files are written to the target project repo.

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

## Rescanning

Running `/onboard <path> rescan` on an already-registered project:
- Archives the current profile as `<component>.<date>.json`
- Runs scout again to refresh the detection report
- Updates the profile with new findings

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
