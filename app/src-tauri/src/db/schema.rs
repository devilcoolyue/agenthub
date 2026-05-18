use super::fts::rebuild_fts_index_sql;
use rusqlite::Connection;

pub(super) const SCHEMA: &str = r#"
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
pub(super) fn migrate(conn: &Connection) {
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
