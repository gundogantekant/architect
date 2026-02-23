# Use Case: Review Code

Comprehensive code review with structured output.

## Input
- Review scope: staged changes, branch diff, or specific file paths
- Portfolio context (from `usecases/load-portfolio-context.md`)

## Output
- Structured review: Summary, Critical Issues, Suggestions, Positive Notes

## Preconditions
- Follow `usecases/load-portfolio-context.md` (fallback: proceed without context)

## Agent(s)
- **reviewer** (model: opus, read-only)

## Steps

1. Determine review scope:
   - "staged" or empty → `git diff --cached`
   - "branch" → `git diff main...HEAD`
   - Otherwise → treat as file paths
2. Gather the diff or file contents
3. Pass scope + portfolio context to reviewer agent
4. Reviewer checks: correctness, security, performance, style, architecture
5. Reviewer produces structured output with file:line references

## Post-conditions
- All findings reference specific file:line locations
- Critical issues are distinguished from suggestions
