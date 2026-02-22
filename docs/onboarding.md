# Onboarding Existing Projects

## Quick Start

```
/onboard /path/to/your/project
```

This runs the scout agent, detects your tech stack, and generates configuration.

## What Gets Detected

- **Language**: TypeScript, Dart, Python, Go, Rust
- **Framework**: React, Flutter, NestJS, FastAPI, Next.js, Express
- **Mobile**: Flutter, Expo, React Native
- **CI/CD**: GitHub Actions, Forgejo Actions
- **Containers**: Docker, Podman
- **Database**: PostgreSQL, SQLite, MongoDB, Firestore
- **Testing**: Jest, Vitest, Pytest, Flutter Test, Maestro
- **Package Manager**: npm, yarn, pnpm, bun, pub, pip, cargo

## What Gets Generated

1. A detection report (JSON) showing all findings
2. Recommended agent list for the project
3. CLAUDE.md additions documenting the stack and agent recommendations

## Manual Setup

If you prefer manual configuration, add to your project's CLAUDE.md:

```markdown
## Stack
- Language: [your language]
- Framework: [your framework]
- Testing: [your test framework]
- CI: [your CI system]

## Recommended Agents
- coder: general implementation
- tester: test generation and execution
- reviewer: code review
- [add relevant specialists]
```

## Example: Flutter Project

Running `/onboard` on a Flutter project detects:
- Language: Dart
- Framework: Flutter
- Mobile: Flutter
- Testing: flutter-test, Maestro
- CI: GitHub Actions (if .github/workflows exists)

Recommended agents: coder-mobile, coder-frontend, tester, ci-cd, reviewer

## Example: TypeScript API

Running `/onboard` on a Node.js API detects:
- Language: TypeScript
- Framework: NestJS/Express/Fastify
- Testing: Jest/Vitest
- Database: PostgreSQL/MongoDB

Recommended agents: coder-backend, tester, coder-infra, reviewer
