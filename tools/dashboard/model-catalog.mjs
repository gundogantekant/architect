// Single source of truth for the model catalog: ids, labels, context window, 1M
// capability, and per-MTok pricing. Consumed by validateModel (utils.mjs), the
// dispatch picker (index.html, via the /api/settings/preferences payload), and the
// pricing migration (046-model-pricing-refresh.mjs).

export const MODEL_ALIASES = {
  sonnet: 'claude-sonnet-4-6',
  opus:   'claude-opus-4-8',
  haiku:  'claude-haiku-4-5-20251001',
};

// input / output are USD per million tokens. cache_read = 0.1 x input and
// cache_write = 1.25 x input are DERIVED by consumers (the pricing migration) and
// intentionally not stored here, to keep one numeric source per model.
export const MODEL_CATALOG = [
  { id: 'claude-fable-5',            label: 'Fable 5',    contextK: 1000, supports1m: true,  input: 10, output: 50 },
  { id: 'claude-opus-4-8',           label: 'Opus 4.8',   contextK: 1000, supports1m: true,  input: 5,  output: 25 },
  { id: 'claude-opus-4-7',           label: 'Opus 4.7',   contextK: 1000, supports1m: true,  input: 5,  output: 25 },
  { id: 'claude-opus-4-6',           label: 'Opus 4.6',   contextK: 1000, supports1m: true,  input: 5,  output: 25 },
  { id: 'claude-sonnet-4-6',         label: 'Sonnet 4.6', contextK: 1000, supports1m: true,  input: 3,  output: 15 },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5',  contextK: 200,  supports1m: false, input: 1,  output: 5  },
];
