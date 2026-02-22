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

## Steps

1. **Load portfolio context**:
   - Resolve the target project path (from cwd or arguments)
   - Look up the path in `portfolio/registry.json` → get `{org, project, component}`
   - If found: read `portfolio/<org>/<project>/<component>.json` and `portfolio/<org>/organization.json`
   - Pass stack info and project structure to the debugger agent
   - If not found: proceed without portfolio context (debugger will explore inline)

2. Use the **debugger** agent (model: sonnet) to investigate:
   - Analyze the issue description from `$ARGUMENTS.issue`
   - Search for relevant error messages, log patterns, and stack traces in the codebase
   - Read the code paths involved
   - Identify potential root causes

3. The debugger will produce a structured bug report:
   - Symptom: what the user sees
   - Root cause: what actually causes it
   - Location: file:line reference
   - Suggested fix
   - Impact assessment

4. If the root cause is identified and a fix is straightforward:
   - Present the proposed fix to the user
   - If approved, implement using the appropriate **coder** agent
   - Use the **tester** agent to verify the fix

5. If the root cause cannot be determined:
   - Report what was investigated
   - Suggest additional diagnostic steps
   - Recommend what information to gather

## Output

- Structured bug report
- Fix implementation (if approved)
- Verification results
