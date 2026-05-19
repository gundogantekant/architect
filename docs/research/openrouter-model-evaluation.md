# OpenRouter Integration Viability for Architect

## Binary Decision

**Yes — Claude Code can use OpenRouter as a drop-in provider.**

OpenRouter exposes a native Anthropic Messages API endpoint (`POST https://openrouter.ai/api/v1/messages`) that satisfies Claude Code's LLM gateway requirements exactly: it serves the Anthropic Messages format, forwards `anthropic-beta` and `anthropic-version` headers, supports prompt caching, and accepts the `ANTHROPIC_BASE_URL` environment variable that Claude Code's gateway path reads. OpenRouter maintains a dedicated integration guide for Claude Code that confirms this is a supported, tested configuration.

## Why Route Through OpenRouter?

### Benefits (Claude models specifically)

- **Provider failover and resilience** — OpenRouter routes across multiple upstream Anthropic providers (Anthropic direct, AWS Bedrock, GCP Vertex). When one is degraded or rate-limited, requests transparently shift to a healthy provider instead of erroring.
- **Unified billing and spend caps** — single invoice across Claude and every other provider used through the gateway. Per-key budget caps, team credit allocation, and per-request cost attribution.
- **Observability dashboard** — per-request usage, latency, cache-hit rate, and the upstream provider that served each call. Optional broadcast to Langfuse / Datadog / Braintrust for downstream tooling. OpenRouter's built-in per-request cost attribution reduces (or eliminates) the need to parse JSONL logs for cost tracking when all dispatches are routed through OpenRouter — the dashboard cost feature only needs to surface the OpenRouter API data rather than recompute it.
- **Model swapping with zero code change** — `ANTHROPIC_DEFAULT_OPUS_MODEL`, `..._SONNET_MODEL`, `..._HAIKU_MODEL` env vars override the tier alias. Swap an agent's model without touching agent prompts.
- **Single key, all providers** — gain access to non-Claude models (DeepSeek, Gemini, Qwen, GPT, Grok, Kimi) through the same gateway, keyed by the same auth token.
- **Optional BYOK** — route through OpenRouter for observability while billing the underlying calls against your own Anthropic / OpenAI / Google API key.
- **Free-tier model access** — rate-limited `:free` variants for development and load testing.

### Drawbacks

- **Latency hop** — one additional network round-trip vs. calling Anthropic directly. In practice ~50-150 ms on top of model latency.
- **Vendor-stated caveat** — OpenRouter's own Claude Code integration page notes that "Claude Code is optimized for Anthropic models and may not work correctly with other providers." Non-Claude models work for many flows but lose Claude-specific features (see §4b below).
- **Margin pricing on non-Anthropic models** — OpenRouter passes Claude pricing through at parity but may apply a small margin on some non-Anthropic models. Verify against the upstream provider's direct price.
- **Cache attribution** — Anthropic's prompt-cache write/read accounting is exposed to OpenRouter but the dashboard does not always re-expose the cache-hit cost discount as cleanly as Anthropic's own console. For Claude-via-OpenRouter the cache still works; only the reporting differs.

## Configuration Approach

Claude Code's gateway feature (`ANTHROPIC_BASE_URL`) routes all API traffic through any endpoint that speaks the Anthropic Messages API format. OpenRouter's `/api/v1/messages` endpoint meets that contract.

### Required environment variables

```bash
# Point Claude Code at OpenRouter's Anthropic-format gateway
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"

# OpenRouter API key as bearer token
export ANTHROPIC_AUTH_TOKEN="<your-openrouter-api-key>"

# Must be explicitly empty to prevent the Anthropic SDK from
# falling back to direct Anthropic API calls
export ANTHROPIC_API_KEY=""
```

Obtain an API key from https://openrouter.ai/settings/keys.

### Per-tier model overrides

Override the model that each architect tier alias resolves to. The variable accepts any OpenRouter model ID — Claude or non-Claude:

```bash
# Opus tier — planner, strategist, security-auditor
export ANTHROPIC_DEFAULT_OPUS_MODEL="anthropic/claude-opus-4-7"

# Sonnet tier — coder-*, reviewer, tester, most agents
export ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/claude-sonnet-4-6"

# Haiku tier — classifier, tracker, dependency-manager, background tasks
export ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/claude-haiku-4-5"

# Sub-agents spawned inside dispatches
export CLAUDE_CODE_SUBAGENT_MODEL="anthropic/claude-sonnet-4-6"
```

To route a tier to a non-Claude model, substitute any model ID from §6 below. See §4 for feature-compatibility caveats.

### Gateway model discovery (optional)

Enable Claude Code to query OpenRouter's `/v1/models` at startup and populate the `/model` picker with all available models:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

Requires Claude Code v2.1.129 or later. Discovery results are cached to `~/.claude/cache/gateway-models.json`. Only models whose ID begins with `claude` or `anthropic` are added automatically; others must be added via `ANTHROPIC_CUSTOM_MODEL_OPTION`.

### Settings file alternative

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "https://openrouter.ai/api",
    "ANTHROPIC_AUTH_TOKEN": "<your-openrouter-api-key>",
    "ANTHROPIC_API_KEY": ""
  }
}
```

### `apiKeyHelper`

Path to an executable script that Claude Code runs whenever it needs an API key. Useful for rotating OpenRouter keys or fetching credentials from a secrets manager (1Password CLI, AWS Secrets Manager, etc.):

```json
{ "apiKeyHelper": "~/.claude/scripts/get-openrouter-key.sh" }
```

### `availableModels`

Restricts the `/model` picker to an approved list. Prevents accidental dispatch to Opus-tier when the task is scoped for Sonnet — useful for cost governance in team environments:

```json
{ "availableModels": ["anthropic/claude-sonnet-4-6", "moonshotai/kimi-k2", "google/gemini-2.5-flash"] }
```

### Alternative: `claude-code-router`

Open-source routing layer ([github.com/musistudio/claude-code-router](https://github.com/musistudio/claude-code-router)) purpose-built for Claude Code. Supports per-role model assignment, multi-provider switching, and in-session `/model` overrides. More targeted than LiteLLM for the Claude Code use case specifically.

## Routing Non-Claude Models

### Yes — and here is how

Set the tier override variable to any OpenRouter model ID. Examples:

```bash
# Route Opus tier to DeepSeek R1
export ANTHROPIC_DEFAULT_OPUS_MODEL="deepseek/deepseek-r1"

# Route Sonnet tier to Kimi K2
export ANTHROPIC_DEFAULT_SONNET_MODEL="moonshotai/kimi-k2"

# Route Haiku tier to Gemini 2.5 Flash
export ANTHROPIC_DEFAULT_HAIKU_MODEL="google/gemini-2.5-flash"
```

No additional environment variables are required beyond the three in §3.

### Mechanism

OpenRouter translates the Anthropic Messages format ↔ the target provider's native format server-side. Claude Code sends Anthropic-format requests; OpenRouter rewrites them for DeepSeek / Gemini / Qwen / OpenAI / etc.; the response is normalized back into Anthropic-format and returned. Claude Code is unaware of the swap.

### Feature compatibility

| Feature | Claude via OpenRouter | Non-Claude via OpenRouter |
|---|---|---|
| Extended thinking (`anthropic-beta` headers) | Works | Lost silently |
| Prompt caching | Works | Lost (some providers cache via their own headers, not surfaced through Claude Code) |
| `opusplan` adaptive reasoning | Works | Lost |
| Tool use (Claude Code tool loop) | Works | Reliable on DeepSeek V3/R1, Gemini 2.5 Pro/Flash, GPT-5, Kimi K2; unreliable on Qwen3-small, Llama 4, Mistral Small |
| Multimodal (images, PDF) | Works | Varies by model |
| Structured output (JSON schema) | Works | Varies; validate with contract tests before production dispatch |

Plan contract tests before routing any architect agent to a non-Claude model. The Technical Review Board verdicts in particular are JSON — a model that drifts on schema compliance will silently fail the gate.

## Per-Role Model Fit

This section maps each architect role to a recommended non-Claude alternative. All recommendations assume the model is reachable through OpenRouter and price/ID are verified at adoption time (see footnote in §6).

### Coding roles

Applies to: `coder`, `coder-frontend`, `coder-backend`, `coder-mobile`, `coder-infra`, `refactorer`, `debugger`.

| Choice | Model | OpenRouter ID | Reasoning |
|---|---|---|---|
| Primary | **Kimi K2** | `moonshotai/kimi-k2` | Strongest SWE-bench in the non-Claude open-weights space; large context; tool-call loop tested with Claude Code |
| Secondary | **Gemini 2.5 Pro** | `google/gemini-2.5-pro` | 1M context, ~78% SWE-bench Verified, mature tool-use; conservative fallback if Kimi K2 instruction-following drops |
| Budget | **DeepSeek V3.1** | `deepseek/deepseek-chat-v3.1` | Lowest cost in this class; weaker instruction-following — best on greenfield code where the task is narrow |

### Architect / reasoning roles

Applies to: `planner`, `strategist`, `security-auditor`.

| Choice | Model | OpenRouter ID | Reasoning |
|---|---|---|---|
| Primary | **Gemini 2.5 Pro Thinking** | `google/gemini-2.5-pro:thinking` | Explicit reasoning trace, 1M context, strong GPQA/AIME; closest non-Claude analogue to Opus for structured architectural decisions |
| Budget | **DeepSeek R1** | `deepseek/deepseek-r1` | Cheap chain-of-thought; verbose output and higher latency are the trade-offs |
| High-capability | **o3** | `openai/o3` | Strong reasoning for security audits where latency is acceptable; not recommended for planner due to latency cost |

Keep `strategist` on Claude Opus by default — strategic evaluation benefits most from `opusplan`-style adaptive reasoning, which non-Claude models lose.

### Review board roles

Applies to: `reviewer`, `tech-reviewer-swe`, `tech-reviewer-arch`, `tech-reviewer-pm`, `tech-reviewer-dba`, `tech-reviewer-systems`, `tech-reviewer-prod`, `tech-reviewer-frontend`, `tech-reviewer-ux`, `tech-reviewer-dx`, `tech-reviewer-iot`.

The board runs in parallel (3-10 agents per gate). Cost reduction here has the highest leverage of any architect surface.

| Sub-group | Recommended model | Reasoning |
|---|---|---|
| Code-focused (`reviewer`, `tech-reviewer-swe`, `-frontend`, `-dx`) | `google/gemini-2.5-pro` or `moonshotai/kimi-k2` | Strong code understanding, reliable structured verdict output |
| Architecture / systems (`tech-reviewer-arch`, `-systems`, `-dba`, `-prod`) | `google/gemini-2.5-pro:thinking` | Reasoning trace surfaces the "why" behind the verdict — useful for board synthesis |
| PM / UX (`tech-reviewer-pm`, `-ux`) | `google/gemini-2.5-flash` or `moonshotai/kimi-k2` | Verdict-quality work; reasoning depth not load-bearing |

Verdicts are JSON. Validate schema compliance with a contract test before adoption — a 1% schema drift rate at the board level means roughly one bad gate per 10 plans reviewed.

### Lightweight / triage roles

Applies to: `classifier`, `scout`, `tracker`, `dependency-manager`, `git-ops`, `coordinator`, `findings-coordinator`, `profiler`.

**Recommendation: keep these on Claude Haiku 4.5.** Tool-call reliability and structured-output guarantees outweigh per-token cost at the volumes involved. Combined savings from swapping these 5-7 roles is small relative to the orchestrator-failure risk if a model emits a tool call as plain text or breaks the JSON schema.

Exception: `browser` (Playwright MCP automation) — trial `google/gemini-2.5-flash`. The 1M context fits page snapshots well; fall back to Sonnet on parsing failures.

Models explicitly **not recommended** for orchestrator-critical roles, based on tool-call format reliability in the Claude-Code-via-OpenRouter path:

- `qwen/qwen3-8b` and `qwen/qwen3-14b` — frequently emit tool calls in markdown or XML instead of the expected JSON tool_calls object
- `meta-llama/llama-4-scout` and `meta-llama/llama-4-maverick` — open-weights instruction-following drifts on structured schemas
- `deepseek/deepseek-chat-v3-0324` for tracker/git-ops — intermittently returns tool calls as plain content text

## Model Comparison Tables

Models available through OpenRouter. Prices are per million tokens. Free-tier variants (`:free` suffix) exist for some models but are rate-limited and unsuitable for production dispatch workloads.

### Haiku tier — fast triage, background tasks (classifier, tracker)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Haiku 4.5** | `anthropic/claude-haiku-4-5` | 200K | $0.80 | $4.00 | Current architect assignment; tool-call support guaranteed |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | 1M | $0.30 | $2.50 | Strong coding, 1M context, fast; watch for tool-call loops with combined structured output |
| Gemini 2.5 Flash Lite | `google/gemini-2.5-flash-lite` | 1M | $0.10 | $0.40 | Cheapest viable structured-output candidate |
| Qwen3 8B | `qwen/qwen3-8b` | 128K | $0.06 | $0.24 | Cheapest; tool-call format unreliable — not recommended for orchestrator roles |
| GPT-4o Mini | `openai/gpt-4o-mini` | 128K | $0.15 | $0.60 | Reliable tool use; OpenAI pricing |
| Mistral Small 3.2 | `mistralai/mistral-small-3.2-24b-instruct` | 128K | $0.15 | $0.60 | Tool-use works but less reliable than Claude baseline through OpenRouter |
| Gemma 3 27B (free) | `google/gemma-3-27b-it:free` | 96K | $0 | $0 | Rate-limited; dev/test only |

### Sonnet tier — general implementation agents (coder-*, reviewer, tester)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Sonnet 4.6** | `anthropic/claude-sonnet-4-6` | 200K | $3.00 | $15.00 | Current architect assignment; full feature support |
| Kimi K2 | `moonshotai/kimi-k2` | 131K-262K | $0.57 | $2.30 | Strong SWE-bench; tool-use proven with Claude Code; primary coding alternative |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | 1M | $1.25 | $10.00 | ~78% SWE-bench Verified; 1M context; secondary coding alternative |
| DeepSeek V3.1 | `deepseek/deepseek-chat-v3.1` | 128K | $0.27 | $1.10 | High coding quality at budget tier; no extended thinking |
| DeepSeek V3.2-Exp | `deepseek/deepseek-v3.2-exp` | 164K | $0.27 | $0.41 | Experimental sparse attention; marginal gain vs V3.1 |
| Qwen3 Coder | `qwen/qwen3-coder-plus` | 256K | ~$0.11 | ~$0.80 | Cheapest viable coder candidate; weaker instruction-following |
| GPT-5 | `openai/gpt-5` | 400K | $1.25 | $10.00 | Competitive with Gemini; reliable tool use |
| Grok 4 | `x-ai/grok-4` | 256K | $3.00 | $15.00 | Native parallel tool calling; no reasoning transparency |
| GLM 4.6 | `z-ai/glm-4.6` | 200K | $0.43 | $1.74 | Mid-tier; structured output reliability not independently validated |
| Mistral Large 3 | `mistralai/mistral-large-2411` | 128K | $2.00 | $6.00 | EU-hosted option |
| Llama 4 Maverick | `meta-llama/llama-4-maverick` | 524K | $0.19 | $0.85 | Open weights; lower instruction-following reliability |

### Opus tier — strategic agents (planner, strategist, security-auditor)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Opus 4.7** | `anthropic/claude-opus-4-7` | 200K | $15.00 | $75.00 | Current architect assignment; strongest reasoning |
| Gemini 2.5 Pro (think) | `google/gemini-2.5-pro:thinking` | 1M | $1.25 | $10.00 | Primary non-Claude opus alternative; explicit reasoning trace |
| DeepSeek R1 | `deepseek/deepseek-r1` | 128K-164K | $0.55 | $2.19 | Chain-of-thought reasoning; very low cost; verbose output |
| o3 | `openai/o3` | 200K | $2.00 | $8.00 | Strong reasoning; ~10s latency; best for security-auditor |
| Grok 4 | `x-ai/grok-4` | 256K | $3.00 | $15.00 | Large context; reasoning capability competitive but no transparency |
| Qwen3 Max | `qwen/qwen3-max` | 262K | $0.78 | $3.90 | Mid-tier reasoning; strong AIME scores |
| Kimi K2 Thinking | `moonshotai/kimi-k2-thinking` | 131K | ~$0.60 | ~$2.50 | Explicit reasoning mode; positioned between K2 base and full opus |
| GPT-4.1 Pro | `openai/gpt-4.1-pro` | 1M | $10.00 | $40.00 | High-capability; 1M context |

*Prices and model availability change frequently and the OpenRouter catalog evolves week-to-week. Verify model IDs and prices at https://openrouter.ai/models on the date of adoption. Last directional snapshot 2026-05-19.*

## Local LLM Backends

Claude Code works with any server that speaks the Anthropic `/v1/messages` protocol — including servers running entirely on your machine. Local backends have zero marginal token cost and no network latency beyond localhost.

### Ollama

Native Anthropic Messages API support since v0.14:

```bash
export ANTHROPIC_BASE_URL="http://localhost:11434"
export ANTHROPIC_API_KEY="ollama"
export ANTHROPIC_AUTH_TOKEN="ollama"
```

Or use the convenience command — `ollama launch claude` sets all three variables automatically.

### LM Studio

Anthropic-compatible `/v1/messages` endpoint since v0.4.1 (GUI model manager):

```bash
export ANTHROPIC_BASE_URL="http://localhost:1234"
export ANTHROPIC_API_KEY="lm-studio"
```

### llama.cpp / vLLM

Any server exposing the Anthropic Messages format on a local port works with the same `ANTHROPIC_BASE_URL` pattern. Both llama.cpp and vLLM support this via their OpenAI-compatible endpoints plus an Anthropic adapter layer.

### Model requirements for architect use

Two hard requirements apply to any local model used with Claude Code:

- **64K+ context minimum** — architect dispatches include portfolio context and prompt history that exceed smaller windows
- **Tool calling support** — mandatory. Models without tool calling can generate text but cannot execute the Claude Code tool loop (file reads, edits, bash commands). The orchestrator silently breaks without it.

### Recommended local models for architect roles (2026)

| Model | Ollama ID | Best tier | Context | Tool calling |
|-------|-----------|-----------|---------|-------------|
| Qwen2.5-Coder 7B | `qwen2.5-coder:7b` | Haiku — triage, tracker | 128K | Yes |
| Qwen2.5-Coder 14B | `qwen2.5-coder:14b` | Sonnet — coding agents | 128K | Yes |
| GLM-4.7-Flash | `glm4:latest` | Sonnet — MoE, 3B active/30B total | 128K | Yes (79.5% agent benchmark) |

**Constraint**: Keep orchestrator-critical roles (classifier, tracker, git-ops) on a cloud model by default. Local models may drift on structured output schemas under high context load. Apply the same tool-call reliability caveats from §5.

## Recommendation and Adoption Path

Routing architect's Claude Code agent dispatches through OpenRouter is viable with no code changes — only three environment variables are required (§3). The primary motivations are provider failover, observability, and selective cost reduction on roles where Claude-specific features are not load-bearing.

A four-phase adoption path minimises capability risk:

**Phase 1 — zero capability risk.** Point all three Claude tier aliases at Claude via OpenRouter. Gain failover, observability, and unified billing. No capability loss. Roll back by unsetting `ANTHROPIC_BASE_URL`.
- Success criterion: dispatch success rate matches direct-Anthropic baseline over a 1-week window.

**Phase 2 — low risk.** Trial `google/gemini-2.5-pro` on `tech-reviewer-pm`, `tech-reviewer-ux`, and `documenter`. These are verdict / prose roles where structured output matters but Claude-specific reasoning features are not load-bearing.
- Success criterion: verdict-fidelity sample (n=20) shows ≥90% agreement with Claude baseline; JSON schema pass rate ≥99%.
- Rollback: revert the per-agent `model:` override in the agent prompt frontmatter.

**Phase 3 — medium risk.** Trial `moonshotai/kimi-k2` or `deepseek/deepseek-chat-v3.1` on `coder-frontend` only (lowest-stakes coder role).
- Success criterion: tester gate pass rate within 5% of Claude Sonnet baseline over 10 work items.
- Rollback: revert override.

**Phase 4 — high risk, optional.** Trial `google/gemini-2.5-pro:thinking` on `planner` for non-critical work items. Keep `strategist` and `security-auditor` on Claude Opus.
- Success criterion: Plan Gate (Technical Review Board) approval rate within 10% of Claude Opus baseline.
- Rollback: revert override.

Do not move lightweight / triage roles (classifier, tracker, git-ops, etc.) off Claude Haiku. The per-token savings are marginal and the orchestrator-failure cost of a missed tool call is high. The single exception is `browser`, which is a candidate for `google/gemini-2.5-flash` due to its large context and Playwright-friendly output shape.

## LiteLLM Proxy

LiteLLM is a local proxy server that accepts Anthropic-format requests and translates them to any upstream provider's native format server-side. Claude Code sends standard Anthropic requests; LiteLLM rewrites them for DeepSeek / Gemini / Ollama / OpenRouter / etc. and normalises the response back. This enables mixing local and cloud backends behind a single `ANTHROPIC_BASE_URL`.

### Setup

```yaml
# litellm_config.yaml
model_list:
  - model_name: claude-haiku-4-5-20251001      # what Claude Code calls it
    litellm_params:
      model: ollama/qwen2.5-coder:7b           # what actually runs
      api_base: http://localhost:11434

  - model_name: claude-sonnet-4-6
    litellm_params:
      model: openrouter/moonshotai/kimi-k2
      api_base: https://openrouter.ai/api/v1
      api_key: <openrouter-key>

  - model_name: claude-opus-4-7
    litellm_params:
      model: anthropic/claude-opus-4-7
      api_key: <anthropic-key>
```

```bash
litellm --config litellm_config.yaml --port 4000
export ANTHROPIC_BASE_URL="http://localhost:4000"
export ANTHROPIC_API_KEY="any-string"
```

### Key capabilities

- **Tier routing without code changes** — maps architect's Haiku/Sonnet/Opus tier aliases to any backend without touching agent prompts or dispatch logic
- **Per-request cost tracking built in** — reduces (or replaces) the custom dashboard cost feature; LiteLLM tracks token usage and estimated USD per request across all backends
- **Model fallback chains** — if Kimi K2 fails or rate-limits, automatically retry with Gemini 2.5 Pro
- **Budget caps and team routing rules** — set per-key spend limits; route different teams to different backends
- **Centralised key management** — one service holds all provider keys; Claude Code only needs the LiteLLM local URL

### Architect relevance

LiteLLM maps directly to the three-tier model table in `CLAUDE.md`. Each tier can route to a different backend independently:

| Architect tier | Example backend | Marginal cost |
|---------------|----------------|--------------|
| Haiku (classifier, tracker) | Local Ollama qwen2.5-coder:7b | ~$0 |
| Sonnet (coder-*, reviewer) | OpenRouter Kimi K2 | ~$0.57/$2.30 per 1M |
| Opus (planner, strategist) | Anthropic Claude Opus direct | $15/$75 per 1M |

Combined with the cost tracking dashboard work item, LiteLLM's built-in cost data can be surfaced via its `/spend` API endpoint rather than requiring JSONL log parsing.
