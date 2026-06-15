# Telegram Bridge

Relays interactive terminal (`T-xxx`) questions and lifecycle events to a Telegram chat, and routes your replies back into the waiting terminal.

## What it does

- Watches running dashboard terminals. When Claude in a terminal asks a question, the bridge sends a notification to your Telegram chat.
- You reply in Telegram; the bridge injects your answer into the correct terminal.
- Also pings on terminal lifecycle (start/exit) so you know when a session ends.
- Detection requires tmux. Non-tmux terminals get lifecycle pings only — no question detection.
- Dispatches (`D-xxx`) are not covered: their stdin closes after the first prompt.

## Setup

1. In Telegram, open **@BotFather** and run `/newbot`.
   - Name: `Architect Orchestrator`
   - Username: `architect_orchestrator_bot`
2. Copy the token BotFather returns. Store it locally in `work/telegram.env`:
   ```
   ARCHITECT_TELEGRAM_BOT_TOKEN=123456:ABC-your-token-here
   ```
   The token must never be committed, stored in PostgreSQL, or logged.
3. Enable the bridge and add your chat to the allowlist:
   ```
   PUT /api/telegram/config
   { "telegram_enabled": true, "allowlist": [6045181745] }
   ```
4. Restart the dashboard so it picks up the token and config:
   ```
   tools/dashboard/dashctl.sh restart
   ```
5. In Telegram, DM the bot `/start` to establish the chat.

## Usage

- Question notifications are tagged: `🔔 T-1234 · org/project · W-567`.
- **Reply-to** a notification message to answer that specific terminal.
- `/sessions` — list terminals currently waiting for input.
- If exactly one terminal is waiting, a plain message (no reply-to) is routed to it (single-waiting fallback).
- The bridge sends a confirmation when a reply is injected, and a failure message (e.g. `target gone`) when the terminal is no longer running.

## Limitations

- Detection is tmux-only; non-tmux terminals get lifecycle pings, not question pings.
- One ping per question (re-displays of the same question do not re-fire).
- Dispatches (`D-xxx`) are not covered — terminals only.
