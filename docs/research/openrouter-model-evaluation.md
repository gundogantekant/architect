# OpenRouter Integration Viability for Architect

## Binary Decision

**Yes — Claude Code can use OpenRouter as a drop-in provider.**

OpenRouter exposes a native Anthropic Messages API endpoint (`POST https://openrouter.ai/api/v1/messages`) that satisfies Claude Code's LLM gateway requirements exactly: it serves the Anthropic Messages format, forwards `anthropic-beta` and `anthropic-version` headers, supports prompt caching, and accepts the `ANTHROPIC_BASE_URL` environment variable that Claude Code's gateway path reads. OpenRouter maintains a dedicated integration guide for Claude Code that confirms this is a supported, tested configuration.

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

### Per-tier model overrides (optional but recommended)

Override the model that each architect tier alias resolves to:

```bash
# Opus tier — complex reasoning, planner, strategist, security-auditor
export ANTHROPIC_DEFAULT_OPUS_MODEL="anthropic/claude-opus-4-7"

# Sonnet tier — coder-*, reviewer, tester, most agents
export ANTHROPIC_DEFAULT_SONNET_MODEL="anthropic/claude-sonnet-4-6"

# Haiku tier — classifier, tracker, dependency-manager, background tasks
export ANTHROPIC_DEFAULT_HAIKU_MODEL="anthropic/claude-haiku-4-5"

# Sub-agents spawned inside dispatches
export CLAUDE_CODE_SUBAGENT_MODEL="anthropic/claude-sonnet-4-6"
```

To route a tier to a non-Claude model, substitute any model ID from the
comparison table below.

### Gateway model discovery (optional)

Enable Claude Code to query OpenRouter's `/v1/models` at startup and populate
the `/model` picker with all available models:

```bash
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
```

Requires Claude Code v2.1.129 or later. Discovery results are cached to
`~/.claude/cache/gateway-models.json`. Only models whose ID begins with
`claude` or `anthropic` are added automatically; others must be added via
`ANTHROPIC_CUSTOM_MODEL_OPTION`.

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

### Known limitation

Claude Code's extended thinking (adaptive reasoning) and `opusplan` fast-mode
rely on Anthropic-specific `anthropic-beta` headers. OpenRouter forwards these
headers, so the features should be preserved for Claude models routed through
OpenRouter. Non-Claude models will not support these features regardless of
gateway.

## Model Comparison Table

Models available through OpenRouter as of 2026-05-16. Prices are per million
tokens. Free-tier variants (`:free` suffix) exist for some models but are
rate-limited and unsuitable for production dispatch workloads.

### Haiku tier — fast triage, background tasks (classifier, tracker)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Haiku 4.5** | `anthropic/claude-haiku-4-5` | 200K | $0.80 | $4.00 | Current architect assignment; tool-call support guaranteed |
| Gemini 2.5 Flash | `google/gemini-2.5-flash` | 1M | $0.15 | $0.60 | Strong coding, 1M context, fast |
| Qwen3 8B | `qwen/qwen3-8b` | 128K | $0.06 | $0.24 | Cheapest option; limited agentic reliability |
| GPT-4o Mini | `openai/gpt-4o-mini` | 128K | $0.15 | $0.60 | Reliable tool use; OpenAI pricing |
| Gemma 3 27B (free) | `google/gemma-3-27b-it:free` | 96K | $0 | $0 | Rate-limited; dev/test only |

### Sonnet tier — general implementation agents (coder-*, reviewer, tester)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Sonnet 4.6** | `anthropic/claude-sonnet-4-6` | 200K | $3.00 | $15.00 | Current architect assignment; full feature support |
| Gemini 2.5 Pro | `google/gemini-2.5-pro` | 1M | $1.25 | $10.00 | Top coding benchmark scores; 1M context |
| DeepSeek V3 | `deepseek/deepseek-chat-v3-0324` | 128K | $0.27 | $1.10 | High coding quality; no extended thinking |
| Mistral Large 3 | `mistralai/mistral-large-2411` | 128K | $2.00 | $6.00 | Strong reasoning; EU-hosted option |
| GPT-4.1 | `openai/gpt-4.1` | 1M | $2.00 | $8.00 | 1M context; reliable tool use |
| Llama 4 Maverick | `meta-llama/llama-4-maverick` | 524K | $0.19 | $0.85 | Open weights; lower instruction-following reliability |

### Opus tier — strategic agents (planner, strategist, security-auditor)

| Model | OpenRouter ID | Context | Input $/1M | Output $/1M | Notes |
|-------|---------------|---------|-----------|-------------|-------|
| **Claude Opus 4.7** | `anthropic/claude-opus-4-7` | 200K | $15.00 | $75.00 | Current architect assignment; strongest reasoning |
| Gemini 2.5 Pro (think) | `google/gemini-2.5-pro:thinking` | 1M | $3.50 | $14.50 | Extended thinking; comparable complex reasoning |
| DeepSeek R1 | `deepseek/deepseek-r1` | 128K | $0.55 | $2.19 | Chain-of-thought reasoning; very low cost |
| GPT-4.1 Pro | `openai/gpt-4.1-pro` | 1M | $10.00 | $40.00 | High-capability; 1M context |
| o3 | `openai/o3` | 200K | $10.00 | $40.00 | Strong reasoning; high latency |

*Prices and model availability retrieved from `https://openrouter.ai/api/v1/models` on 2026-05-16. Prices change frequently; verify at https://openrouter.ai/models before adoption.*

## Recommendation

Routing architect's Claude Code agent dispatches through OpenRouter is viable with no code changes — only three environment variables (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY=""`) are required. The primary motivation for adopting OpenRouter would be provider failover (resilience when Anthropic's API is degraded) and cost reduction via non-Claude alternatives on the haiku and sonnet tiers, where DeepSeek V3 and Gemini 2.5 Flash offer 90%+ cost savings relative to their Claude equivalents at competitive quality. However, architect's dispatch contracts rely heavily on Claude-specific capabilities — extended thinking for planner/strategist agents, adaptive reasoning, and `opusplan` hybrid mode — and non-Claude models will silently drop these features. The recommended adoption path is to keep all three tier aliases pointed at Claude models through OpenRouter initially (gaining failover and observability at zero capability cost), then selectively trial non-Claude alternatives only on the haiku tier (classifier, tracker, dependency-manager) where the tasks are constrained enough to validate parity safely.
