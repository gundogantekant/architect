# Use Case: Diagnose Issue

Investigate and diagnose a bug or issue.

## Input
- Issue description (free-form text)
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Structured bug report: symptom, root cause, location, suggested fix, impact

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: proceed without context, debugger explores inline)

## Agent(s)
- **debugger** (model: sonnet) — investigation
- **coder** (appropriate variant) — fix implementation (if approved)
- **tester** (model: sonnet) — fix verification

## Steps

1. Load portfolio context for stack info and project structure
2. Debugger agent investigates: error messages, log patterns, stack traces, code paths
3. Debugger produces structured bug report
4. If root cause identified and fix is straightforward:
   - Present proposed fix to user
   - If approved: implement with coder agent, verify with tester agent
5. If root cause unclear:
   - Report what was investigated
   - Suggest additional diagnostic steps

## Post-conditions
- Bug report includes file:line references
- Fix is only implemented after user approval
