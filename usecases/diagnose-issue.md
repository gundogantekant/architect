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
   - If approved: create a worktree via `usecases/manage-worktree.md` → create, implement with coder agent in worktree, verify with tester agent in worktree
   - After tester verification passes: dispatch coder to remove all debug artifacts introduced during investigation and fix. Debug artifacts must not be present in the final commit. See `domain/rules.md` → Debug Artifact Rules.
   - Present results: offer `/pr` to merge or `/worktree cleanup` to discard
5. If root cause unclear:
   - Report what was investigated
   - Suggest additional diagnostic steps

6. If the debugger's findings include actionable issues and the user requests follow-up remediation dispatch: follow `usecases/synthesize-findings.md` — pass the debugger findings as `## Findings`, the user's original issue as `## Goal`, and the resolved target_project as `## Context`.

## Debugging Guidelines

When portfolio context includes debug-related guidance (via `custom_rules`, `dispatch_notes.debugger`, or `portfolio_guides`), pass it to the debugger agent. The debugger must follow project-specific conventions over generic practices. See `usecases/load-portfolio-context.md` → Debug context augmentation.

## Post-conditions
- Bug report includes file:line references
- Fix is only implemented after user approval
- All debug artifacts introduced during the workflow are removed before completion
