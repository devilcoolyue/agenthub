use super::fts::{rebuild_fts_index_sql, searchable_text};
use super::hash::event_hash;
use super::Db;
use crate::agent::{Agent, AgentEvent, EventKind};
use anyhow::Result;
use rusqlite::params;

impl Db {
    /// Insert event; returns true if a new row was added, false if the
    /// event hash collided with an existing row.
    pub fn insert(&self, ev: &AgentEvent) -> Result<bool> {
        let data = serde_json::to_string(ev)?;
        let hash = event_hash(ev);
        let risk_high = ev
            .risk_tags
            .iter()
            .any(|t| t == "shell-dangerous" || t == "secret-path") as i32;
        let agent = match ev.agent {
            Agent::ClaudeCode => "claude-code",
            Agent::Codex => "codex",
        };
        let ts = ev.timestamp.to_rfc3339();
        let (model, input_t, cache_create_t, cache_read_t, output_t, reasoning_t, cost) =
            match &ev.usage {
                Some(u) => (
                    u.model.clone(),
                    u.input_tokens as i64,
                    u.cache_creation_tokens as i64,
                    u.cache_read_tokens as i64,
                    u.output_tokens as i64,
                    u.reasoning_tokens as i64,
                    u.cost_micros as i64,
                ),
                None => (None, 0, 0, 0, 0, 0, 0),
            };
        let conn = self.conn.lock().unwrap();
        let changes = conn.execute(
            "INSERT OR IGNORE INTO events
                (agent, session_id, timestamp, risk_high, data,
                 model, input_tokens, cache_creation_tokens, cache_read_tokens, output_tokens, reasoning_tokens, cost_micros,
                 event_hash)
             VALUES (?,?,?,?,?, ?,?,?,?,?,?,?, ?)",
            params![
                agent, ev.session_id, ts, risk_high, data,
                model, input_t, cache_create_t, cache_read_t, output_t, reasoning_t, cost,
                hash
            ],
        )?;
        if changes > 0 {
            let event_id = conn.last_insert_rowid();
            if let Some((text, kind_tag)) = searchable_text(ev) {
                let _ = conn.execute(
                    "INSERT INTO events_fts (rowid, text, session_id, agent, cwd, kind, ts)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                    params![event_id, text, ev.session_id, agent, ev.cwd, kind_tag, ts],
                );
            }
            let tool_inc = matches!(ev.kind, EventKind::ToolUse { .. }) as i64;
            // Upsert session aggregate. cwd uses prefer-non-null;
            // start/end widen monotonically.
            conn.execute(
                r#"
                INSERT INTO sessions
                    (session_id, agent, cwd, start_ts, end_ts,
                     event_count, tool_count, high_risk_count, cost_micros)
                VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    -- Pin cwd to the first non-null value we see for a session
                    -- (the launch dir). Don't let mid-session `cd` drift it.
                    cwd = CASE WHEN sessions.cwd IS NOT NULL THEN sessions.cwd ELSE excluded.cwd END,
                    start_ts = CASE WHEN excluded.start_ts < sessions.start_ts THEN excluded.start_ts ELSE sessions.start_ts END,
                    end_ts   = CASE WHEN excluded.end_ts > sessions.end_ts   THEN excluded.end_ts   ELSE sessions.end_ts   END,
                    event_count     = sessions.event_count + 1,
                    tool_count      = sessions.tool_count + excluded.tool_count,
                    high_risk_count = sessions.high_risk_count + excluded.high_risk_count,
                    cost_micros     = sessions.cost_micros + excluded.cost_micros
                "#,
                params![
                    ev.session_id,
                    agent,
                    ev.cwd,
                    ts,
                    ts,
                    tool_inc,
                    risk_high,
                    cost,
                ],
            )?;
        }
        Ok(changes > 0)
    }

    /// Catch up the FTS index for any events not yet indexed. Idempotent —
    /// safe to call on demand from the settings UI as well as during backfill.
    pub fn backfill_fts(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        rebuild_fts_index_sql(&conn)
    }

    /// Compute hashes for legacy rows where `event_hash` is NULL.
    /// Returns the number of rows updated.
    pub fn backfill_hashes(&self) -> Result<usize> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, data FROM events WHERE event_hash IS NULL")?;
        let rows: Vec<(i64, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        drop(stmt);
        let tx = conn.unchecked_transaction()?;
        let mut updated = 0usize;
        for (id, data) in rows {
            if let Ok(ev) = serde_json::from_str::<AgentEvent>(&data) {
                let h = event_hash(&ev);
                // unique constraint may reject if a dup already exists with hash; in that
                // case delete this orphan row instead so we converge on a clean state.
                match tx.execute("UPDATE events SET event_hash = ? WHERE id = ?", params![h, id]) {
                    Ok(_) => updated += 1,
                    Err(_) => {
                        let _ = tx.execute("DELETE FROM events WHERE id = ?", params![id]);
                    }
                }
            }
        }
        tx.commit()?;
        Ok(updated)
    }

    pub fn recent(&self, limit: usize) -> Result<Vec<AgentEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM events ORDER BY id DESC LIMIT ?")?;
        let mut rows = stmt.query(params![limit as i64])?;
        let mut out: Vec<AgentEvent> = Vec::new();
        while let Some(row) = rows.next()? {
            let s: String = row.get(0)?;
            if let Ok(ev) = serde_json::from_str::<AgentEvent>(&s) {
                out.push(ev);
            }
        }
        out.reverse(); // return ascending by time
        Ok(out)
    }

    pub fn count(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))?;
        Ok(n)
    }

    /// On-disk size of the SQLite database in bytes, including WAL/journal pages
    /// that haven't been checkpointed back into the main file. Uses
    /// `page_count * page_size` so it reflects what SQLite is actually holding,
    /// not what `stat()` sees on the .db file alone.
    pub fn size_bytes(&self) -> Result<i64> {
        let conn = self.conn.lock().unwrap();
        let page_count: i64 = conn.query_row("PRAGMA page_count", [], |r| r.get(0))?;
        let page_size: i64 = conn.query_row("PRAGMA page_size", [], |r| r.get(0))?;
        Ok(page_count.saturating_mul(page_size))
    }

    /// Delete events whose local-day timestamp is older than `days` days ago,
    /// then rebuild the sessions aggregate table and VACUUM to release pages
    /// back to the OS. Returns (rows_deleted, bytes_freed). bytes_freed may be
    /// negative if VACUUM happens to grow the file (rare); callers should clamp
    /// to >= 0 when displaying.
    pub fn purge_older_than(&self, days: u32) -> Result<(i64, i64)> {
        let conn = self.conn.lock().unwrap();
        let before_pages: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(0);
        let page_size: i64 = conn
            .query_row("PRAGMA page_size", [], |r| r.get(0))
            .unwrap_or(0);

        let deleted = {
            let tx = conn.unchecked_transaction()?;
            let n = tx.execute(
                "DELETE FROM events
                 WHERE DATE(timestamp,'localtime')
                     < DATE('now','localtime','-' || ? || ' days')",
                params![days as i64],
            )? as i64;
            // Rebuild session aggregates so counts/start/end reflect surviving rows.
            tx.execute("DELETE FROM sessions", [])?;
            tx.execute_batch(
                r#"
                INSERT INTO sessions
                    (session_id, agent, cwd, start_ts, end_ts,
                     event_count, tool_count, high_risk_count, cost_micros)
                SELECT
                    e.session_id,
                    MAX(e.agent),
                    (SELECT json_extract(e2.data, '$.cwd')
                       FROM events e2
                      WHERE e2.session_id = e.session_id
                        AND json_extract(e2.data, '$.cwd') IS NOT NULL
                      ORDER BY e2.timestamp ASC LIMIT 1),
                    MIN(e.timestamp),
                    MAX(e.timestamp),
                    COUNT(*),
                    SUM(CASE WHEN json_extract(e.data, '$.kind.type') = 'tool_use' THEN 1 ELSE 0 END),
                    SUM(e.risk_high),
                    SUM(e.cost_micros)
                FROM events e
                GROUP BY e.session_id;
                "#,
            )?;
            tx.commit()?;
            n
        };

        // VACUUM cannot run inside a transaction; release space now that
        // the delete is committed.
        let _ = conn.execute_batch("VACUUM;");

        let after_pages: i64 = conn
            .query_row("PRAGMA page_count", [], |r| r.get(0))
            .unwrap_or(before_pages);
        let freed = before_pages.saturating_sub(after_pages).saturating_mul(page_size);
        Ok((deleted, freed))
    }

    pub fn session_events(&self, session_id: &str) -> Result<Vec<AgentEvent>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT data FROM events WHERE session_id = ? ORDER BY id ASC")?;
        let mut rows = stmt.query(params![session_id])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            let s: String = row.get(0)?;
            if let Ok(ev) = serde_json::from_str::<AgentEvent>(&s) {
                out.push(ev);
            }
        }
        Ok(out)
    }
}
