# Use Case: Web Automation

Perform a task on a web service on the user's behalf.

## Input
- Task description (what to accomplish)
- Target URL
- Pre-collected inputs (field values, settings, parameters)
- Steps to perform (if known)

## Output
- Task completion status (success/partial/failed)
- Evidence: screenshots at key steps, final page state snapshot

## Preconditions
- Playwright MCP is connected
- User has provided the task description and any known inputs

## Agent(s)
- **browser** (model: sonnet) — web interaction

## Steps

0. **Model affinity check** (main session only): If the orchestrator is about to use Playwright tools directly (not via subagent dispatch), follow the Model Affinity Rules in `domain/rules.md` to prompt the user for a model switch before proceeding.
1. Orchestrator collects all known inputs from user before dispatch
2. Browser agent navigates to target URL
3. Agent follows the task steps, filling forms and clicking through workflows
4. When a sensitive field is encountered (password, API key, auth token):
   - Agent pauses and asks user via AskUserQuestion
   - User provides the value
   - Agent continues
5. Agent captures screenshots at key decision points
6. Agent reports completion status with evidence

## Post-conditions
- Screenshots saved to tmp/
- Final page state captured via accessibility snapshot
- User informed of success or failure with evidence
