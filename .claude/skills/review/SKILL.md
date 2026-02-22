---
name: review
description: Comprehensive code review of staged changes, branch diff, or specific files
user_invocable: true
arguments:
  - name: scope
    description: "Review scope: 'staged' for staged changes, 'branch' for branch diff, or file paths"
    required: false
---

# /review

Run a comprehensive code review.

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - Pass project conventions and stack info to the reviewer agent
   - If not found: proceed without portfolio context

2. Determine the review scope:
   - If `$ARGUMENTS.scope` is "staged" or empty: review git staged changes (`git diff --cached`)
   - If `$ARGUMENTS.scope` is "branch": review diff between current branch and base branch (`git diff main...HEAD`)
   - Otherwise: treat as file paths and review those specific files

3. Gather the diff or file contents to review

4. Use the **reviewer** agent (model: opus) to perform the review:
   - Check correctness, security, performance, style, architecture
   - Produce structured review with Critical Issues, Suggestions, and Positive Notes
   - Reference specific file:line locations

5. Present the review results

## Output

- Structured code review with severity levels
- Specific file:line references for each finding
- Summary assessment
