# Work Tracking

## Overview

The `/work` command provides persistent work item tracking across sessions. Items are stored in `work/backlog.json` and can reference portfolio projects.

## Commands

| Command | Action |
|---------|--------|
| `/work` | Show open and in-progress items |
| `/work add <title> [options]` | Create a work item |
| `/work show <ID>` | Full detail with session log |
| `/work update <ID> <status>` | Change status |
| `/work log <ID> <message>` | Append session log entry |
| `/work list [filters]` | Filtered listing |
| `/work remove <ID>` | Delete an item |

## Options for `add`

- `--project <org/project/component>` — link to portfolio project (auto-resolved from cwd if omitted)
- `--priority <low|medium|high|critical>` — default: medium
- `--tags <a,b,c>` — comma-separated tags

## Filters for `list`

- `--status <open|in-progress|blocked|done|cancelled>`
- `--project <org/project/component>`
- `--tag <tag>`

## Statuses

| Status | Meaning |
|--------|---------|
| open | Ready to start |
| in-progress | Currently being worked on |
| blocked | Waiting on dependency or external input |
| done | Completed |
| cancelled | No longer needed |

## Session Log

Each item has an append-only session log for cross-session continuity. Use `/work log W-001 "message"` to record progress at the end of a session or when switching context.

## Data Store

`work/backlog.json` — single JSON file with sequential W-XXX IDs. IDs are never reused.

## PM Integration

PM suggests work items for medium+ complexity requests. The orchestrator presents the suggestion and creates it only after user confirmation.
