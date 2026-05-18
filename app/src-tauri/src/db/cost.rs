use super::Db;
use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCost {
    pub day: String,             // YYYY-MM-DD local
    pub agent: String,
    /// Model the tokens were billed against. Rows are grouped by
    /// (day, agent, model) so the frontend can apply per-model pricing.
    pub model: String,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    /// Stale: computed at insert time using legacy hardcoded prices. The
    /// frontend re-derives cost from the raw token fields above + user-edited
    /// per-model pricing, so this number is kept only for wire compat.
    pub cost_micros: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelCost {
    pub model: String,
    pub input_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_creation_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_micros: i64,
}

/// Per-(session, model) token-by-type breakdown. Separates output from
/// reasoning so the UI can show codex thinking-token spend independently.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelUsage {
    pub model: String,
    pub input_tokens: i64,
    pub cache_creation_tokens: i64,
    pub cache_read_tokens: i64,
    pub output_tokens: i64,
    pub reasoning_tokens: i64,
    pub cost_micros: i64,
}

impl Db {
    /// Per-day per-agent cost rollup for the last `days` local days,
    /// ordered DESC (today first).
    pub fn daily_cost(&self, days: usize) -> Result<Vec<DailyCost>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                DATE(timestamp, 'localtime') AS day,
                agent,
                COALESCE(model, 'unknown') AS m,
                SUM(input_tokens),
                SUM(cache_read_tokens),
                SUM(cache_creation_tokens),
                SUM(output_tokens),
                SUM(reasoning_tokens),
                SUM(cost_micros)
            FROM events
            WHERE (input_tokens + cache_creation_tokens + cache_read_tokens
                   + output_tokens + reasoning_tokens) > 0
              AND DATE(timestamp, 'localtime') >= DATE('now', 'localtime', '-' || ? || ' days')
            GROUP BY day, agent, m
            ORDER BY day DESC, agent, m
            "#,
        )?;
        let rows = stmt.query_map(params![days as i64], |r| {
            Ok(DailyCost {
                day: r.get(0)?,
                agent: r.get(1)?,
                model: r.get(2)?,
                input_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                cache_creation_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                reasoning_tokens: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                cost_micros: r.get::<_, Option<i64>>(8)?.unwrap_or(0),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Cost rollup by model over the last `days` local days.
    pub fn model_cost(&self, days: usize) -> Result<Vec<ModelCost>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                COALESCE(model, 'unknown') AS m,
                SUM(input_tokens),
                SUM(cache_read_tokens),
                SUM(cache_creation_tokens),
                SUM(output_tokens),
                SUM(reasoning_tokens),
                SUM(cost_micros)
            FROM events
            WHERE (input_tokens + cache_creation_tokens + cache_read_tokens
                   + output_tokens + reasoning_tokens) > 0
              AND DATE(timestamp, 'localtime') >= DATE('now', 'localtime', '-' || ? || ' days')
            GROUP BY m
            ORDER BY SUM(input_tokens + output_tokens + reasoning_tokens) DESC
            "#,
        )?;
        let rows = stmt.query_map(params![days as i64], |r| {
            Ok(ModelCost {
                model: r.get(0)?,
                input_tokens: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                cache_creation_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                reasoning_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cost_micros: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    /// Per-model token-by-type breakdown for a single session. Rows with no
    /// usage data at all are skipped; one row per distinct model the session
    /// actually billed against.
    pub fn session_usage(&self, session_id: &str) -> Result<Vec<ModelUsage>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                COALESCE(model, 'unknown') AS m,
                SUM(input_tokens),
                SUM(cache_creation_tokens),
                SUM(cache_read_tokens),
                SUM(output_tokens),
                SUM(reasoning_tokens),
                SUM(cost_micros)
            FROM events
            WHERE session_id = ?
              AND (input_tokens + cache_creation_tokens + cache_read_tokens
                   + output_tokens + reasoning_tokens) > 0
            GROUP BY m
            ORDER BY SUM(cost_micros) DESC, m
            "#,
        )?;
        let rows = stmt.query_map(params![session_id], |r| {
            Ok(ModelUsage {
                model: r.get(0)?,
                input_tokens: r.get::<_, Option<i64>>(1)?.unwrap_or(0),
                cache_creation_tokens: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                cache_read_tokens: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
                output_tokens: r.get::<_, Option<i64>>(4)?.unwrap_or(0),
                reasoning_tokens: r.get::<_, Option<i64>>(5)?.unwrap_or(0),
                cost_micros: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
