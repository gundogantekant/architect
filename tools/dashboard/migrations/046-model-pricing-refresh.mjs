// Refresh model_pricing from the model-catalog single source of truth, adding the
// full recent 6-model lineup (Fable 5, Opus 4.8/4.7/4.6, Sonnet 4.6, Haiku 4.5).
// cache_read = input * 0.1 and cache_write = input * 1.25 are derived here.
//
// NOTE: dispatch_costs.cost_usd_breakdown is an immutable snapshot computed at insert
// time (see insertDispatchCost in db.mjs), so this migration affects only FORWARD cost
// computations, not already-recorded rows.

import { MODEL_CATALOG } from '../model-catalog.mjs';

export const id = '046-model-pricing-refresh';
export const description = 'Refresh model_pricing from model-catalog (full 6-model lineup)';

export async function up(db) {
  for (const m of MODEL_CATALOG) {
    await db.query(
      `INSERT INTO model_pricing
         (model_id, input_cost_per_mtok, output_cost_per_mtok, cache_read_cost_per_mtok, cache_write_cost_per_mtok, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (model_id) DO UPDATE SET
         input_cost_per_mtok = EXCLUDED.input_cost_per_mtok,
         output_cost_per_mtok = EXCLUDED.output_cost_per_mtok,
         cache_read_cost_per_mtok = EXCLUDED.cache_read_cost_per_mtok,
         cache_write_cost_per_mtok = EXCLUDED.cache_write_cost_per_mtok,
         updated_at = NOW()`,
      [m.id, m.input, m.output, m.input * 0.1, m.input * 1.25]
    );
  }
}

// No-op: prior per-row pricing values are not captured before the upsert, so they
// cannot be restored safely. Matches the architect convention of non-reversible seeds.
export async function down(_db) {}
