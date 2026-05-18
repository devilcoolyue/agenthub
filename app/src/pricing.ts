// Per-model pricing table + cost helpers.
//
// All prices are USD micros per million tokens (so $5/MTok = 5_000_000). We
// store in micros to avoid float drift across many small per-event additions.
//
// Defaults are sourced from:
//   - Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   - OpenAI:    https://developers.openai.com/api/docs/pricing
// Users can override any entry via Settings; entries not in the table fall
// back to FALLBACK_PRICE.

const M = 1_000_000;

export interface ModelPrice {
  /** USD micros per 1M tokens, applied to `input_tokens`. */
  input: number;
  /** Applied to `cache_creation_tokens`. For Anthropic this is the 5-minute
   *  cache-write rate. OpenAI bills cache writes at the standard input rate;
   *  Codex events report `cache_creation_tokens=0` so this value is mostly
   *  cosmetic for OpenAI models. */
  cacheCreate: number;
  /** Applied to `cache_read_tokens`. */
  cacheRead: number;
  /** Applied to `output_tokens` AND `reasoning_tokens`. Codex bills reasoning
   *  at the output rate, so we collapse them onto the same price knob. */
  output: number;
}

/** What a Usage record needs to look like for cost computation. The actual
 *  Usage type lives in types.ts; we accept a structural subset so this module
 *  doesn't depend on the wire types. */
export interface UsageLike {
  model?: string | null;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}

/** Default catalog. Keys are model API strings. Patterns with trailing dates
 *  (e.g. `claude-haiku-4-5-20251001`) are normalized to the dateless form
 *  before lookup. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  // ===== Anthropic =====
  // Opus 4.5+ tier
  "claude-opus-4-7": { input: 5 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M, output: 25 * M },
  "claude-opus-4-6": { input: 5 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M, output: 25 * M },
  "claude-opus-4-5": { input: 5 * M, cacheCreate: 6.25 * M, cacheRead: 0.5 * M, output: 25 * M },
  // Opus 4.0/4.1 tier (legacy pricing)
  "claude-opus-4-1": { input: 15 * M, cacheCreate: 18.75 * M, cacheRead: 1.5 * M, output: 75 * M },
  "claude-opus-4-0": { input: 15 * M, cacheCreate: 18.75 * M, cacheRead: 1.5 * M, output: 75 * M },
  // Sonnet
  "claude-sonnet-4-6": { input: 3 * M, cacheCreate: 3.75 * M, cacheRead: 0.3 * M, output: 15 * M },
  "claude-sonnet-4-5": { input: 3 * M, cacheCreate: 3.75 * M, cacheRead: 0.3 * M, output: 15 * M },
  "claude-sonnet-4-0": { input: 3 * M, cacheCreate: 3.75 * M, cacheRead: 0.3 * M, output: 15 * M },
  // Haiku
  "claude-haiku-4-5": { input: 1 * M, cacheCreate: 1.25 * M, cacheRead: 0.1 * M, output: 5 * M },
  "claude-haiku-3-5": { input: 0.8 * M, cacheCreate: 1 * M, cacheRead: 0.08 * M, output: 4 * M },

  // ===== OpenAI Codex =====
  // For OpenAI we set cacheCreate = input because their pricing has no separate
  // cache-write line; cache writes are charged at the standard input rate.
  // Codex events always emit cache_creation_tokens=0 so this rarely matters.
  "gpt-5.5":       { input: 5 * M,    cacheCreate: 5 * M,    cacheRead: 0.5 * M,   output: 30 * M },
  "gpt-5.5-pro":   { input: 30 * M,   cacheCreate: 30 * M,   cacheRead: 30 * M,    output: 180 * M },
  "gpt-5.4":       { input: 2.5 * M,  cacheCreate: 2.5 * M,  cacheRead: 0.25 * M,  output: 15 * M },
  "gpt-5.4-mini":  { input: 0.75 * M, cacheCreate: 0.75 * M, cacheRead: 0.075 * M, output: 4.5 * M },
  "gpt-5.4-nano":  { input: 0.2 * M,  cacheCreate: 0.2 * M,  cacheRead: 0.02 * M,  output: 1.25 * M },
  "gpt-5.4-pro":   { input: 30 * M,   cacheCreate: 30 * M,   cacheRead: 30 * M,    output: 180 * M },
  "gpt-5.3-codex": { input: 1.75 * M, cacheCreate: 1.75 * M, cacheRead: 0.175 * M, output: 14 * M },
};

/** Used for unknown models. Roughly mid-tier (Sonnet / GPT-5.4) so estimates
 *  stay in the right order of magnitude until the user adds an override. */
export const FALLBACK_PRICE: ModelPrice = {
  input: 3 * M,
  cacheCreate: 3.75 * M,
  cacheRead: 0.3 * M,
  output: 15 * M,
};

/** Drop a trailing `-YYYYMMDD` so dated Anthropic IDs hit the dateless price
 *  entries (e.g. `claude-haiku-4-5-20251001` → `claude-haiku-4-5`). */
export function normalizeModelKey(model: string): string {
  return model.replace(/-\d{8}$/, "");
}

/** All keys the user can reasonably configure: the union of default + override
 *  keys, with their normalized form. Used to render the settings table. */
export function knownModelKeys(overrides: Record<string, Partial<ModelPrice>>): string[] {
  const set = new Set<string>(Object.keys(DEFAULT_PRICES));
  for (const k of Object.keys(overrides)) set.add(normalizeModelKey(k));
  return Array.from(set).sort();
}

/** Resolve the effective price for a given model string, applying user
 *  overrides on top of the matching default. Overrides are sparse (per-field),
 *  so unspecified fields fall back to the default for that model. */
export function priceFor(
  model: string | null | undefined,
  overrides: Record<string, Partial<ModelPrice>>,
): ModelPrice {
  if (!model) return FALLBACK_PRICE;
  const key = normalizeModelKey(model);
  const base = DEFAULT_PRICES[key] ?? DEFAULT_PRICES[model] ?? FALLBACK_PRICE;
  const ov = overrides[key] ?? overrides[model];
  if (!ov) return base;
  return {
    input: ov.input ?? base.input,
    cacheCreate: ov.cacheCreate ?? base.cacheCreate,
    cacheRead: ov.cacheRead ?? base.cacheRead,
    output: ov.output ?? base.output,
  };
}

/** Whether a model name has an exact (post-normalization) entry in the
 *  default catalog. Used so the UI can warn about unknowns. */
export function hasDefault(model: string | null | undefined): boolean {
  if (!model) return false;
  const key = normalizeModelKey(model);
  return key in DEFAULT_PRICES || model in DEFAULT_PRICES;
}

/** Compute cost in USD micros for a single Usage record. Reasoning tokens are
 *  billed at the output rate (matches OpenAI's reasoning-as-output rule, and
 *  for Anthropic where reasoning_tokens=0 it has no effect). */
export function computeCostMicros(
  u: UsageLike,
  overrides: Record<string, Partial<ModelPrice>>,
): number {
  const p = priceFor(u.model, overrides);
  // Integer math via Math.round to avoid float drift on small per-event sums.
  return Math.round(
    (u.input_tokens * p.input
      + u.cache_creation_tokens * p.cacheCreate
      + u.cache_read_tokens * p.cacheRead
      + (u.output_tokens + u.reasoning_tokens) * p.output)
      / 1_000_000,
  );
}
