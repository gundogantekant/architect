---
name: secure
description: Run a security audit on the project
user_invocable: true
---

# /secure

Run a comprehensive security audit.

## Agents Dispatched
- **security-auditor** (opus) — OWASP analysis, secrets detection
- **dependency-manager** (haiku) — CVE checks

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **full** (fallback: run scout to detect the project stack)

2. Follow `usecases/security-audit.md`

## Output

### Security Report
- Overall risk level (CRITICAL/HIGH/MEDIUM/LOW)
- Findings organized by severity
- Each finding includes: location, description, impact, remediation
- Dependency vulnerability list
- Prioritized action items
