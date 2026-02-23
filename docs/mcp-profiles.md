# MCP Session Profiles

## Problem

Claude Code subagents inherit all parent MCP connections. Every connected MCP service injects its full tool schema into every agent dispatch, regardless of whether that agent needs those tools. This wastes context window tokens.

## Solution

Keep the main orchestration session MCP-free. Connect MCP servers only for specific session purposes using `--mcp-config`.

## Available Profiles

### Clean (default)

No MCP servers. Used for general orchestration, planning, and code implementation.

```
claude
```

### Playwright (browser automation)

Connects Playwright MCP for E2E testing, visual regression, and browser-based debugging.

```
claude --mcp-config .claude/mcp/playwright.json
```

Enables the **browser** agent. Useful when:
- Running `/test` with E2E scope on web projects
- Using `/diagnose` to reproduce browser-based bugs
- Performance analysis requiring Core Web Vitals measurement

## Config Files

| File | MCP Server | Token Cost |
|------|-----------|------------|
| `.claude/mcp/playwright.json` | Playwright | ~30 tool definitions |

## Evaluated and Skipped

| MCP Service | Verdict | Rationale |
|-------------|---------|-----------|
| Docker | Skip | `coder-infra` handles Docker via Bash with zero context overhead |
| GitHub | Skip | `gh` CLI covers PRs, issues, releases without context cost |
| Notion | Defer | Local `work/backlog.json` is simpler for task tracking |
| Slack | Defer | Webhook-based notifications via Bash cost zero context tokens |
| Database | Defer | Project-specific; add per-project when needed |
