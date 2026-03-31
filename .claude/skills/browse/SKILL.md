---
name: browse
description: Perform a web automation task via Playwright browser agent
execution: dispatch
user_invocable: true
arguments:
  - name: task
    description: What to accomplish on the web (URL + actions)
    required: true
---

# /browse

Perform a web automation task using the browser agent and Playwright MCP.

## Agents Dispatched
- **browser** (sonnet) — web interaction via Playwright

## Steps

1. Skip portfolio context loading (web automation is project-independent)

2. Collect inputs from `$ARGUMENTS.task`:
   - Parse the task description for target URL, actions, and field values
   - If the target URL is missing, ask the user via `AskUserQuestion`
   - If the task requires specific field values not provided, ask the user upfront

3. Dispatch **browser** agent with the collected inputs:
   - Target URL
   - Steps to perform
   - Pre-collected field values
   - Expected outcome

4. Follow `usecases/web-automate.md` for the execution workflow

## Output

- Task completion status (success/partial/failed)
- Screenshots at key steps saved to `tmp/`
- Final page state summary

## Safety

- Sensitive data (passwords, API keys, tokens) is never pre-collected — the browser agent asks at the moment of need
- Never guess or skip authentication fields
- Always capture evidence screenshots for user verification
