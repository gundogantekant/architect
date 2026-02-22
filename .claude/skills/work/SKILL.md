---
name: work
description: Track work items across sessions
user_invocable: true
arguments:
  - name: subcommand
    description: "Action: add, show, update, log, list, remove (default: list open+in-progress)"
    required: false
  - name: args
    description: "Arguments for the subcommand (title, ID, status, message, filters)"
    required: false
---

# /work

Persistent work item tracking across sessions.

## Steps

1. **Parse command**:
   - No arguments or `list`: list open + in-progress items
   - `add <title> [--project X] [--priority Y] [--tags a,b]`: create item
   - `show <W-XXX>`: show full detail
   - `update <W-XXX> <status>`: change status (open, in-progress, blocked, done, cancelled)
   - `log <W-XXX> <message>`: append session log entry
   - `list [--status X] [--project Y] [--tag Z]`: filtered list
   - `remove <W-XXX>`: delete item (confirm with user first)

2. **Auto-resolve project** (for `add` without `--project`):
   - Check if the current working directory maps to a portfolio entry via `portfolio/registry.json`
   - If found, use as default project reference

3. **Handle remove confirmation**:
   - For `remove`: show the item title and ask "Remove W-XXX: <title>?" before dispatching

4. **Dispatch tracker agent**:
   - Use the **tracker** agent (model: haiku, max turns: 10)
   - Pass the parsed command string
   - Pass today's date for log entries
   - If a project was auto-resolved, include it in the command

5. **Display result**:
   - Show the tracker's output directly to the user

## Usage

```
/work                                          Show open + in-progress items
/work add "Migrate state management"           Create with defaults
/work add "Add rate limiting" --project neuronic/cloud/main --priority high --tags api,feature
/work show W-001                               Full detail + session log
/work update W-001 in-progress                 Change status
/work log W-001 "Completed investigation phase"  Append log entry
/work list --status blocked                    Filter by status
/work list --project neuronic/light-app/main   Filter by project
/work list --tag refactor                      Filter by tag
/work remove W-001                             Delete (with confirmation)
```
