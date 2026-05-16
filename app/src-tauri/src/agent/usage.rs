use serde::{Deserialize, Serialize};

/// Per-event token usage (delta, not cumulative).
/// `cost_micros` = USD * 1_000_000 (integer math, no float drift).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Usage {
    pub model: Option<String>,
    pub input_tokens: u64,
    pub cache_creation_tokens: u64,
    pub cache_read_tokens: u64,
    pub output_tokens: u64,
    pub reasoning_tokens: u64, // codex-specific; priced as output
    pub cost_micros: u64,
}

/// All prices in micros (USD * 1e6) per 1M tokens.
/// Source: vendor list pricing as of 2026-05. Update when models or prices change.
#[derive(Debug, Clone, Copy)]
struct Price {
    input_per_mtok: u64,
    cache_creation_per_mtok: u64,
    cache_read_per_mtok: u64,
    output_per_mtok: u64,
}

const PRICE_OPUS: Price = Price {
    input_per_mtok: 15_000_000,
    cache_creation_per_mtok: 18_750_000,
    cache_read_per_mtok: 1_500_000,
    output_per_mtok: 75_000_000,
};
const PRICE_SONNET: Price = Price {
    input_per_mtok: 3_000_000,
    cache_creation_per_mtok: 3_750_000,
    cache_read_per_mtok: 300_000,
    output_per_mtok: 15_000_000,
};
const PRICE_HAIKU: Price = Price {
    input_per_mtok: 1_000_000,
    cache_creation_per_mtok: 1_250_000,
    cache_read_per_mtok: 100_000,
    output_per_mtok: 5_000_000,
};
// OpenAI GPT-5 family — list pricing approximation. Subscription pricing
// (Plus / Pro) will be much lower; we'll surface this as "list price" in UI.
const PRICE_GPT5: Price = Price {
    input_per_mtok: 1_250_000,
    cache_creation_per_mtok: 1_250_000,
    cache_read_per_mtok: 125_000,
    output_per_mtok: 10_000_000,
};
const PRICE_UNKNOWN: Price = PRICE_SONNET; // conservative fallback

fn lookup_price(model: &str) -> Price {
    let m = model.to_ascii_lowercase();
    if m.contains("opus") {
        PRICE_OPUS
    } else if m.contains("sonnet") {
        PRICE_SONNET
    } else if m.contains("haiku") {
        PRICE_HAIKU
    } else if m.starts_with("gpt-5") || m.starts_with("gpt-4o") || m.starts_with("o1") || m.starts_with("o3") {
        PRICE_GPT5
    } else {
        PRICE_UNKNOWN
    }
}

/// Cost = sum(tokens * price / 1M), rounded as integer division.
pub fn compute_cost_micros(u: &Usage) -> u64 {
    let model = u.model.as_deref().unwrap_or("");
    let p = lookup_price(model);
    let mtok = 1_000_000u128;
    let cost = (u.input_tokens as u128) * (p.input_per_mtok as u128) / mtok
        + (u.cache_creation_tokens as u128) * (p.cache_creation_per_mtok as u128) / mtok
        + (u.cache_read_tokens as u128) * (p.cache_read_per_mtok as u128) / mtok
        + ((u.output_tokens + u.reasoning_tokens) as u128) * (p.output_per_mtok as u128) / mtok;
    cost.min(u64::MAX as u128) as u64
}

impl Usage {
    pub fn finalize(mut self) -> Self {
        self.cost_micros = compute_cost_micros(&self);
        self
    }
}
