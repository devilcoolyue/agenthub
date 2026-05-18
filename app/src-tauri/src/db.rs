use crate::agent::{Agent, AgentEvent, EventKind};
use anyhow::{Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::Path;
use std::sync::Mutex;

/// Stable per-event fingerprint for idempotent backfill / dedup.
/// First 16 bytes of sha256 over a normalized representation. ~3.4×10^38 keyspace,
/// collision in practice negligible for our scale.
pub fn event_hash(ev: &AgentEvent) -> String {
    let mut h = Sha256::new();
    let agent = match ev.agent {
        Agent::ClaudeCode => "claude-code",
        Agent::Codex => "codex",
    };
    h.update(agent.as_bytes());
    h.update(b"|");
    h.update(ev.session_id.as_bytes());
    h.update(b"|");
    h.update(ev.timestamp.to_rfc3339().as_bytes());
    h.update(b"|");
    match &ev.kind {
        EventKind::SessionStart { model, version } => {
            h.update(b"session_start|");
            h.update(model.as_deref().unwrap_or("").as_bytes());
            h.update(b"|");
            h.update(version.as_deref().unwrap_or("").as_bytes());
        }
        EventKind::UserPrompt { text } => {
            h.update(b"user_prompt|");
            h.update(text.as_bytes());
        }
        EventKind::AssistantThinking => h.update(b"assistant_thinking"),
        EventKind::AssistantText { text } => {
            h.update(b"assistant_text|");
            h.update(text.as_bytes());
        }
        EventKind::ToolUse { name, summary, .. } => {
            h.update(b"tool_use|");
            h.update(name.as_bytes());
            h.update(b"|");
            h.update(summary.as_bytes());
        }
        EventKind::ToolResult { ok, summary } => {
            h.update(if *ok { b"tool_result_ok|".as_slice() } else { b"tool_result_err|".as_slice() });
            h.update(summary.as_bytes());
        }
        EventKind::System { text } => {
            h.update(b"system|");
            h.update(text.as_bytes());
        }
        EventKind::Usage => {
            h.update(b"usage|");
            if let Some(u) = &ev.usage {
                h.update(
                    format!(
                        "{}|{}|{}|{}",
                        u.input_tokens, u.cache_read_tokens, u.output_tokens, u.reasoning_tokens
                    )
                    .as_bytes(),
                );
            }
        }
        EventKind::Other { tag } => {
            h.update(b"other|");
            h.update(tag.as_bytes());
        }
    }
    let bytes = h.finalize();
    let mut out = String::with_capacity(32);
    for b in &bytes[..16] {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

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

/// Wrap a raw user query as a single FTS5 phrase: doubles embedded quotes and
/// wraps in `"…"` so operators (`*`, `:`, `NEAR`, parens) in the input are
/// treated literally. With the trigram tokenizer this gives substring-style
/// matching across CJK + ASCII without needing word segmentation.
fn fts_phrase(q: &str) -> String {
    let mut out = String::with_capacity(q.len() + 2);
    out.push('"');
    for ch in q.chars() {
        if ch == '"' {
            out.push('"');
            out.push('"');
        } else {
            out.push(ch);
        }
    }
    out.push('"');
    out
}

/// Pure-SQL idempotent FTS rebuild. Returns rows newly inserted. Safe to call
/// on every startup — the LEFT JOIN filters out rows already in `events_fts`.
/// Hardcodes the JSON shape of `EventKind` for ~10× speedup over deserializing
/// each row through serde; keep this in sync with [`searchable_text`].
fn rebuild_fts_index_sql(conn: &Connection) -> Result<usize> {
    let n = conn.execute(
        r#"
        INSERT INTO events_fts (rowid, text, session_id, agent, cwd, kind, ts)
        SELECT
            e.id,
            CASE json_extract(e.data, '$.kind.type')
                WHEN 'user_prompt'    THEN json_extract(e.data, '$.kind.text')
                WHEN 'assistant_text' THEN json_extract(e.data, '$.kind.text')
                WHEN 'tool_use'       THEN
                    COALESCE(json_extract(e.data, '$.kind.name'),'')
                    || ' '
                    || COALESCE(json_extract(e.data, '$.kind.summary'),'')
                WHEN 'tool_result'    THEN json_extract(e.data, '$.kind.summary')
                WHEN 'system'         THEN json_extract(e.data, '$.kind.text')
            END AS text,
            e.session_id,
            e.agent,
            json_extract(e.data, '$.cwd') AS cwd,
            json_extract(e.data, '$.kind.type') AS kind,
            e.timestamp
        FROM events e
        LEFT JOIN events_fts f ON f.rowid = e.id
        WHERE f.rowid IS NULL
          AND json_extract(e.data, '$.kind.type') IN
            ('user_prompt','assistant_text','tool_use','tool_result','system')
        "#,
        [],
    )?;
    Ok(n)
}

/// Extract the searchable text payload from an event. Returns None for kinds
/// that don't carry user-facing prose (SessionStart, AssistantThinking, Usage, Other).
fn searchable_text(ev: &AgentEvent) -> Option<(String, &'static str)> {
    match &ev.kind {
        EventKind::UserPrompt { text } => Some((text.clone(), "user_prompt")),
        EventKind::AssistantText { text } => Some((text.clone(), "assistant_text")),
        EventKind::ToolUse { name, summary, .. } => {
            Some((format!("{} {}", name, summary), "tool_use"))
        }
        EventKind::ToolResult { summary, .. } => Some((summary.clone(), "tool_result")),
        EventKind::System { text } => Some((text.clone(), "system")),
        _ => None,
    }
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

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    agent       TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    timestamp   TEXT NOT NULL,
    risk_high   INTEGER NOT NULL DEFAULT 0,
    data        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_id_desc ON events(id DESC);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_agent_ts ON events(agent, timestamp);

CREATE TABLE IF NOT EXISTS sessions (
    session_id      TEXT PRIMARY KEY,
    agent           TEXT NOT NULL,
    cwd             TEXT,
    start_ts        TEXT NOT NULL,
    end_ts          TEXT NOT NULL,
    event_count     INTEGER NOT NULL DEFAULT 0,
    tool_count      INTEGER NOT NULL DEFAULT 0,
    high_risk_count INTEGER NOT NULL DEFAULT 0,
    cost_micros     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sessions_end_ts ON sessions(end_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_cwd ON sessions(cwd);

-- Single-row-per-key app state. Used for one-shot signals (e.g. "a migration
-- removed data, please re-backfill"). Keep entries tiny + transient.
CREATE TABLE IF NOT EXISTS app_kv (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Full-text search index over event prose. rowid mirrors events.id.
-- trigram tokenizer gives substring/CJK matching without language-specific
-- segmentation; minimum useful query length is 3 chars.
CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
    text,
    session_id UNINDEXED,
    agent      UNINDEXED,
    cwd        UNINDEXED,
    kind       UNINDEXED,
    ts         UNINDEXED,
    tokenize='trigram'
);
"#;

/// Add columns / indexes if missing (idempotent — ALTER errors are ignored).
fn migrate(conn: &Connection) {
    let _ = conn.execute("ALTER TABLE events ADD COLUMN model TEXT", []);
    for col in &[
        "input_tokens",
        "cache_creation_tokens",
        "cache_read_tokens",
        "output_tokens",
        "reasoning_tokens",
        "cost_micros",
    ] {
        let _ = conn.execute(
            &format!("ALTER TABLE events ADD COLUMN {} INTEGER NOT NULL DEFAULT 0", col),
            [],
        );
    }
    let _ = conn.execute("ALTER TABLE events ADD COLUMN event_hash TEXT", []);
    let _ = conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_events_cost ON events(timestamp) WHERE cost_micros > 0;
         CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hash ON events(event_hash) WHERE event_hash IS NOT NULL;",
    );

    // If sessions table is empty but events has rows, rebuild it once.
    let sessions_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap_or(0);
    let events_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0))
        .unwrap_or(0);
    if sessions_count == 0 && events_count > 0 {
        let _ = conn.execute_batch(
            r#"
            INSERT INTO sessions (session_id, agent, cwd, start_ts, end_ts, event_count, tool_count, high_risk_count, cost_micros)
            SELECT
                e.session_id,
                MAX(e.agent),
                -- Launch cwd: first non-null cwd seen for this session by
                -- chronological order. MAX(json_extract(...)) would pick the
                -- lexicographically-largest string, not what we want.
                (SELECT json_extract(e2.data, '$.cwd')
                   FROM events e2
                  WHERE e2.session_id = e.session_id
                    AND json_extract(e2.data, '$.cwd') IS NOT NULL
                  ORDER BY e2.timestamp ASC LIMIT 1) AS cwd,
                MIN(e.timestamp) AS start_ts,
                MAX(e.timestamp) AS end_ts,
                COUNT(*) AS event_count,
                SUM(CASE WHEN json_extract(e.data, '$.kind.type') = 'tool_use' THEN 1 ELSE 0 END) AS tool_count,
                SUM(e.risk_high) AS high_risk_count,
                SUM(e.cost_micros) AS cost_micros
            FROM events e
            GROUP BY e.session_id;
            "#,
        );
    }

    // Idempotent FTS catch-up: indexes any events.id that aren't already in
    // events_fts. On a fresh upgrade this is the one-shot bulk fill; on every
    // subsequent boot it's a fast no-op (or covers any rows the tail path
    // missed during an interrupted write).
    if events_count > 0 {
        let _ = rebuild_fts_index_sql(conn);
    }

    // Schema-version migrations. user_version semantics:
    //   0 → pre-fix: sessions.cwd was last-seen (drifts on mid-session `cd`)
    //   1 → sessions.cwd pinned to first non-null cwd by timestamp
    //   2 → events.reasoning_tokens split out from output_tokens (codex thinking)
    let user_version: i64 = conn
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap_or(0);
    if user_version < 1 && events_count > 0 {
        let _ = conn.execute_batch(
            r#"
            UPDATE sessions
            SET cwd = (
                SELECT json_extract(e.data, '$.cwd')
                FROM events e
                WHERE e.session_id = sessions.session_id
                  AND json_extract(e.data, '$.cwd') IS NOT NULL
                ORDER BY e.timestamp ASC
                LIMIT 1
            )
            WHERE EXISTS (
                SELECT 1 FROM events e
                WHERE e.session_id = sessions.session_id
                  AND json_extract(e.data, '$.cwd') IS NOT NULL
            );
            PRAGMA user_version = 1;
            "#,
        );
    }
    if user_version < 2 {
        // Pre-v2 rows merged reasoning into the output_tokens column on insert.
        // The original split is still in events.data (`$.usage.reasoning_tokens`),
        // so subtract it back out and populate the new column.
        let _ = conn.execute_batch(
            r#"
            UPDATE events
            SET reasoning_tokens = COALESCE(CAST(json_extract(data, '$.usage.reasoning_tokens') AS INTEGER), 0),
                output_tokens    = output_tokens
                                 - COALESCE(CAST(json_extract(data, '$.usage.reasoning_tokens') AS INTEGER), 0)
            WHERE COALESCE(CAST(json_extract(data, '$.usage.reasoning_tokens') AS INTEGER), 0) > 0;
            PRAGMA user_version = 2;
            "#,
        );
    }
    if user_version < 3 {
        // Pre-v3 parser ignored turn_context.payload.model so every codex Usage
        // row was stamped with the hardcoded "gpt-5" fallback. The right model
        // is only on disk (turn_context isn't stored as an event), so drop the
        // bad rows, recompute session totals, and flag a re-backfill on next
        // launch so the corrected parser can re-import them.
        let _ = conn.execute_batch(
            r#"
            DELETE FROM events
            WHERE agent = 'codex'
              AND json_extract(data, '$.kind.type') = 'usage';

            UPDATE sessions
            SET cost_micros = COALESCE(
                (SELECT SUM(cost_micros) FROM events e WHERE e.session_id = sessions.session_id),
                0
            );

            INSERT OR REPLACE INTO app_kv (key, value)
            VALUES ('pending_backfill', 'codex_model_recovery');

            PRAGMA user_version = 3;
            "#,
        );
    }
    if user_version < 4 {
        // v3 cleared the bad rows and triggered a re-backfill, but the v3
        // parser still fell back to "gpt-5" when turn_context hadn't been
        // seen yet (e.g. token_count arrived first). v4 drops every codex
        // usage row whose model is exactly "gpt-5" — the bare major-version
        // string is never what real codex emits (turn_context always carries
        // a minor like "gpt-5.5" / "gpt-5.3-codex"). Re-backfill picks up the
        // accurate model on the next launch.
        let _ = conn.execute_batch(
            r#"
            DELETE FROM events
            WHERE agent = 'codex'
              AND json_extract(data, '$.kind.type') = 'usage'
              AND json_extract(data, '$.usage.model') = 'gpt-5';

            UPDATE sessions
            SET cost_micros = COALESCE(
                (SELECT SUM(cost_micros) FROM events e WHERE e.session_id = sessions.session_id),
                0
            );

            INSERT OR REPLACE INTO app_kv (key, value)
            VALUES ('pending_backfill', 'codex_model_recovery_v4');

            PRAGMA user_version = 4;
            "#,
        );
    }
}

pub struct Db {
    conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("open db {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch(SCHEMA)?;
        migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

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

    pub fn kv_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_kv WHERE key = ?",
            params![key],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn kv_delete(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM app_kv WHERE key = ?", params![key]);
    }
}
