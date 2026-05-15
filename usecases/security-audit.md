# Use Case: Security Audit

Comprehensive security audit of a project.

## Input
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Security report: risk level, findings by severity, dependency vulnerabilities, action items

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: run scout to detect the project stack)

## Agent(s)
- **security-auditor** (model: opus, read-only) — OWASP analysis, secrets detection, auth review
- **dependency-manager** (model: haiku) — CVE and outdated package checks

## Steps

1. Load portfolio context for stack info
2. Security-auditor performs full audit:
   - OWASP Top 10 analysis
   - Secrets detection (hardcoded keys, committed .env files)
   - Dependency vulnerability scan
   - Authentication/authorization review
   - Infrastructure security (Docker, CI/CD)
   - Input validation assessment
3. Dependency-manager checks for known CVEs and outdated packages with security patches
4. Combine into unified security report

4. If security findings include actionable vulnerabilities and the user requests remediation dispatch: follow `usecases/synthesize-findings.md` — pass security audit findings as `## Findings`, the remediation goal as `## Goal`, and the resolved target_project as `## Context`.

## Post-conditions
- Findings organized by severity (CRITICAL/HIGH/MEDIUM/LOW)
- Each finding includes: location, description, impact, remediation
