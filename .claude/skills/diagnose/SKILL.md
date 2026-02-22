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

1. Use the **debugger** agent (model: sonnet) to investigate:
   - Analyze the issue description from `$ARGUMENTS.issue`
   - Search for relevant error messages, log patterns, and stack traces in the codebase
   - Read the code paths involved
   - Identify potential root causes

2. The debugger will produce a structured bug report:
   - Symptom: what the user sees
   - Root cause: what actually causes it
   - Location: file:line reference
   - Suggested fix
   - Impact assessment

3. If the root cause is identified and a fix is straightforward:
   - Present the proposed fix to the user
   - If approved, implement using the appropriate **coder** agent
   - Use the **tester** agent to verify the fix

4. If the root cause cannot be determined:
   - Report what was investigated
   - Suggest additional diagnostic steps
   - Recommend what information to gather

## Output

- Structured bug report
- Fix implementation (if approved)
- Verification results
