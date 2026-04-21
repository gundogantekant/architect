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
- **reviewer** (model: opus, read-only) — detailed code review with file:line findings
- **tech-reviewer-*** (model: sonnet, read-only) — Review Board for governance verdicts (context-filtered, 3–10 agents)

## Steps

1. Determine review scope:
   - "staged" or empty → `git diff --cached`
   - "branch" → `git diff main...HEAD`
   - Otherwise → treat as file paths
2. Gather the diff or file contents
3. Pass scope + portfolio context to reviewer agent
4. Reviewer checks: correctness, security, performance, style, architecture
5. Reviewer produces structured output with file:line references
6. **Review Board — Code Gate** (per `domain/rules.md` → Review Board Rules): Assemble the review board using context-based composition rules. Dispatch all selected tech-reviewer-* agents **in parallel** with the diff (artifact_type=diff) and portfolio context. Collect `TechReviewVerdict` from each. Apply aggregation rules to produce `TechReviewBoardResult`.
7. Present both reviewer findings (detailed) and board verdicts (governance) to user

## Post-conditions
- All reviewer findings reference specific file:line locations
- Critical issues are distinguished from suggestions
- Board verdicts (approve/revise/block) are shown alongside detailed findings
