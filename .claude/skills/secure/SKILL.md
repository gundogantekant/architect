---
name: secure
description: Run a security audit on the project
user_invocable: true
---

# /secure

Run a comprehensive security audit.

## Steps

1. Follow `usecases/load-portfolio-context.md` (fallback: run scout to detect the project stack)

2. Follow `usecases/security-audit.md`

## Output

### Security Report
- Overall risk level (CRITICAL/HIGH/MEDIUM/LOW)
- Findings organized by severity
- Each finding includes: location, description, impact, remediation
- Dependency vulnerability list
- Prioritized action items
