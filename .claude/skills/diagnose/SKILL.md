---
name: diagnose
description: Debug an issue by analyzing logs, tracing, and reproducing
user_invocable: true
arguments:
  - name: issue
    description: Description of the issue to diagnose
    required: true
---

# /diagnose

Investigate and diagnose a bug or issue.

## Agents Dispatched
- **debugger** (sonnet) — investigation
- **coder** (inherit) — fix implementation
- **tester** (sonnet) — fix verification

## Steps

1. Follow `usecases/load-portfolio-context.md` with depth **standard** (fallback: proceed without context, debugger explores inline)

2. Follow `usecases/diagnose-issue.md` with issue from `$ARGUMENTS.issue`

## Output

- Structured bug report
- Fix implementation (if approved)
- Verification results
