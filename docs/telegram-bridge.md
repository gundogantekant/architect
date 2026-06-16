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
   Optionally, add an Anthropic API key on its own line to enable readable, Haiku-rewritten pings (without it, pings fall back to cleaned raw pane text):
   ```
   ANTHROPIC_API_KEY=sk-ant-your-key-here
   ```
   `work/telegram.env` is sourced by `dashctl` on start/restart. Like the bot token, this key must never be committed, stored in PostgreSQL, or logged.
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

## Replying

A question ping shows a plain-language summary of what the agent is asking plus the numbered options it offers. To answer:

1. Reply in your own words, or just send the option number (e.g. `2`).
2. The bot maps your reply to a choice and asks you to confirm: `→ 2. <label>. Send ok to confirm, cancel to abort, or rephrase`.
3. Send `ok` to actuate. The bot then confirms: `✅ selected → 2 (verify in dashboard if it didn't take)`.
   - Send `cancel` to abort, or just send a different reply to re-map.

Notes:
- **Stale screen** — if the agent has moved on since the ping (the dialog changed or vanished), the bot reports `session moved on` and does not send keystrokes to the changed prompt. Re-check the dashboard and reply to the current ping.
- **Expiry** — a pending (unconfirmed) decision expires after about 5 minutes. After that, send your answer again; it re-maps against the current screen.
- Without `ANTHROPIC_API_KEY` set, free-text replies still work via deterministic number/label matching, but plain-language summaries are replaced by cleaned raw pane text.

## Notifications

Three independent toggles control which events fire a ping. Set them in `#settings` → Telegram, or via `PUT /api/telegram/config` with `{ "notify_questions": true, "notify_idle": false, "notify_lifecycle": false }`:

- **Question prompts** (`notify_questions`, default **on**) — ping when an agent shows a question (dialog screen).
- **Idle prompts** (`notify_idle`, default **off**) — ping when an agent sits idle at its input composer.
- **Agent exit** (`notify_lifecycle`, default **off**) — ping when a terminal exits.

Back-compat: the legacy single `telegram_trigger` preference is honored only when none of the three `notify_*` preferences exist (`questions_lifecycle` → questions + exit, `questions` → questions only).

## Limitations

- Detection is tmux-only; non-tmux terminals get lifecycle pings, not question pings.
- One ping per question (re-displays of the same question do not re-fire).
- Dispatches (`D-xxx`) are not covered — terminals only.
