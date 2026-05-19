# Cost Tracking

Per-dispatch token consumption and computed USD cost, attributed to each dispatch, work item, project, and epic.

## Cost Formula

```
cost_usd = (input_tokens   * input_cost_per_mtok   / 1_000_000)
         + (output_tokens  * output_cost_per_mtok  / 1_000_000)
         + (cache_read_tok * cache_read_cost_per_mtok  / 1_000_000)
         + (cache_write_tok* cache_write_cost_per_mtok / 1_000_000)
```

Prices are read from the `model_pricing` table at insert time and stored as `cost_usd_breakdown` on the `dispatch_costs` row.

## Model Pricing

Current seed values (USD per million tokens):

| Model | Input | Output | Cache Read | Cache Write |
|---|---|---|---|---|
| claude-opus-4-7 | 15.0 | 75.0 | 1.5 | 3.75 |
| claude-sonnet-4-6 | 3.0 | 15.0 | 0.3 | 3.75 |
| claude-haiku-4-5-20251001 | 0.8 | 4.0 | 0.08 | 1.0 |

### Updating Prices

Update the pricing table directly in PostgreSQL, then restart the server:

```sql
UPDATE model_pricing
SET input_cost_per_mtok = 3.0,
    output_cost_per_mtok = 15.0,
    updated_at = NOW()
WHERE model_id = 'claude-sonnet-4-6';
```

New dispatches started after restart will use the updated prices. Existing `dispatch_costs` rows retain the cost computed at the time of dispatch completion.

## Storage Architecture

Two tables serve distinct purposes:

- **`dispatches.cost_usd`** — total cost reported by the Claude CLI result event (`total_cost_usd`). Used by cost-anomaly detection (`getProjectAvgDispatchCost()` in `db.mjs`, checked in `dispatch-manager.mjs` after close). This field is preserved as-is.

- **`dispatch_costs`** — separate table with per-token granularity (input, output, cache_read, cache_write). Populated from the `usage` field of the result event when available. Used for rollup endpoints and UI badges.

## PTY / Interactive Terminal Limitation

Interactive terminal sessions (`/api/terminal`) use a PTY (pseudo-terminal) and do not expose token or cost signals via the Claude CLI. The cost cannot be attributed after the fact without access to the Anthropic API directly.

Terminal panels therefore display a `—` placeholder instead of a cost figure. This is a known limitation — it reflects the absence of data, not a zero cost.

## API Endpoints

| Endpoint | Returns |
|---|---|
| `GET /api/costs/work-item/:id` | `{ total_cost_usd, total_tokens, sessions }` |
| `GET /api/costs/project/:key` | `{ total_cost_usd, total_tokens, sessions }` |
| `GET /api/costs/epic/:id` | `{ total_cost_usd, total_tokens, sessions }` |

## Attribution Hierarchy

```
dispatch_costs row
  → work item  (via dispatches.work_item_id)
  → project    (via dispatches.project_key)
  → epic       (via dispatches.epic_id)
```

Rollup endpoints aggregate `cost_usd_breakdown` from `dispatch_costs` across the relevant scope via a JOIN on the `dispatches` table.

## UI Badges

- **Dispatch session panels**: show `$X.XXXX` cost badge when `cost_usd` is populated on the dispatch object (populated from the result event).
- **Terminal session panels**: show `—` placeholder because PTY sessions carry no cost signal.
