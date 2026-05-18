use super::fts::fts_phrase;
use super::Db;
use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub agent: String,
    pub cwd: Option<String>,
    pub start_ts: String,
    pub end_ts: String,
    pub event_count: i64,
    pub high_risk_count: i64,
    pub tool_count: i64,
    /// Highlighted snippet from full-text search (only set when query matched event content).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_snippet: Option<String>,
    /// Number of events in this session whose text matched the FTS query.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub match_count: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionCategory {
    pub cwd: Option<String>,
    pub session_count: i64,
    pub high_risk_session_count: i64,
    pub event_count: i64,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default)]
pub struct SessionsFilter {
    pub cwd: Option<String>,
    pub query: Option<String>,
    pub high_risk_only: bool,
}

impl Db {
    pub fn list_sessions(
        &self,
        filter: &SessionsFilter,
        limit: usize,
        offset: usize,
    ) -> Result<Vec<SessionSummary>> {
        let conn = self.conn.lock().unwrap();
        let cwd_param = filter.cwd.as_deref();
        let high_only = if filter.high_risk_only { 1i64 } else { 0i64 };
        let raw_query = filter.query.as_deref().map(str::trim).filter(|s| !s.is_empty());

        // FTS5 trigram tokenizer needs at least 3 chars per token; below that
        // it returns nothing, so fall back to LIKE-only.
        let fts_query: Option<String> = raw_query
            .filter(|q| q.chars().count() >= 3)
            .map(fts_phrase);

        if let Some(fts_q) = fts_query {
            // Combined search: union FTS content hits with LIKE matches on
            // cwd / session_id. Content hits get a snippet and a match count
            // and are ordered before path/id-only matches.
            let mut stmt = conn.prepare(
                r#"
                WITH fts_hits AS (
                    -- One row per matching event, ranked. snippet() and
                    -- bm25() reference the FTS5 table in the same FROM clause.
                    SELECT session_id,
                           snippet(events_fts, 0, '<<', '>>', '…', 12) AS snippet,
                           bm25(events_fts) AS rank
                    FROM events_fts
                    WHERE text MATCH ?1
                ),
                fts_sessions AS (
                    -- Collapse to one row per session, keeping the snippet
                    -- from the highest-ranked (lowest bm25) match.
                    SELECT session_id,
                           COUNT(*) AS match_count,
                           (SELECT snippet FROM fts_hits h2
                             WHERE h2.session_id = fts_hits.session_id
                             ORDER BY rank LIMIT 1) AS snippet
                    FROM fts_hits
                    GROUP BY session_id
                )
                SELECT s.session_id, s.agent, s.cwd, s.start_ts, s.end_ts,
                       s.event_count, s.high_risk_count, s.tool_count,
                       f.snippet, f.match_count
                FROM sessions s
                LEFT JOIN fts_sessions f ON f.session_id = s.session_id
                WHERE (?2 IS NULL OR s.cwd = ?2)
                  AND (?3 = 0 OR s.high_risk_count > 0)
                  AND ( f.session_id IS NOT NULL
                     OR LOWER(IFNULL(s.cwd,'')) LIKE '%' || LOWER(?4) || '%'
                     OR LOWER(s.session_id)    LIKE '%' || LOWER(?4) || '%' )
                ORDER BY CASE WHEN f.session_id IS NOT NULL THEN 0 ELSE 1 END,
                         s.end_ts DESC
                LIMIT ?5 OFFSET ?6
                "#,
            )?;
            let rows = stmt.query_map(
                params![fts_q, cwd_param, high_only, raw_query, limit as i64, offset as i64],
                |r| {
                    Ok(SessionSummary {
                        session_id: r.get(0)?,
                        agent: r.get(1)?,
                        cwd: r.get::<_, Option<String>>(2)?,
                        start_ts: r.get(3)?,
                        end_ts: r.get(4)?,
                        event_count: r.get(5)?,
                        high_risk_count: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                        tool_count: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                        match_snippet: r.get::<_, Option<String>>(8)?,
                        match_count: r.get::<_, Option<i64>>(9)?,
                    })
                },
            )?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r?);
            }
            return Ok(out);
        }

        // No query, or query too short for FTS — list/filter only.
        let mut stmt = conn.prepare(
            r#"
            SELECT session_id, agent, cwd, start_ts, end_ts,
                   event_count, high_risk_count, tool_count
            FROM sessions
            WHERE (?1 IS NULL OR cwd = ?1)
              AND (?2 = 0 OR high_risk_count > 0)
              AND (?3 IS NULL
                   OR LOWER(IFNULL(cwd,'')) LIKE '%' || LOWER(?3) || '%'
                   OR LOWER(session_id)     LIKE '%' || LOWER(?3) || '%')
            ORDER BY end_ts DESC
            LIMIT ?4 OFFSET ?5
            "#,
        )?;
        let rows = stmt.query_map(
            params![cwd_param, high_only, raw_query, limit as i64, offset as i64],
            |r| {
                Ok(SessionSummary {
                    session_id: r.get(0)?,
                    agent: r.get(1)?,
                    cwd: r.get::<_, Option<String>>(2)?,
                    start_ts: r.get(3)?,
                    end_ts: r.get(4)?,
                    event_count: r.get(5)?,
                    high_risk_count: r.get::<_, Option<i64>>(6)?.unwrap_or(0),
                    tool_count: r.get::<_, Option<i64>>(7)?.unwrap_or(0),
                    match_snippet: None,
                    match_count: None,
                })
            },
        )?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }

    pub fn list_session_categories(&self) -> Result<Vec<SessionCategory>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            r#"
            SELECT
                cwd,
                COUNT(*) AS session_count,
                SUM(CASE WHEN high_risk_count > 0 THEN 1 ELSE 0 END) AS high_risk_session_count,
                SUM(event_count) AS event_count
            FROM sessions
            GROUP BY cwd
            ORDER BY event_count DESC
            "#,
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(SessionCategory {
                cwd: r.get::<_, Option<String>>(0)?,
                session_count: r.get::<_, i64>(1)?,
                high_risk_session_count: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                event_count: r.get::<_, Option<i64>>(3)?.unwrap_or(0),
            })
        })?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r?);
        }
        Ok(out)
    }
}
