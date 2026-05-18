use crate::agent::{AgentEvent, EventKind};
use anyhow::Result;
use rusqlite::Connection;

/// Wrap a raw user query as a single FTS5 phrase: doubles embedded quotes and
/// wraps in `"…"` so operators (`*`, `:`, `NEAR`, parens) in the input are
/// treated literally. With the trigram tokenizer this gives substring-style
/// matching across CJK + ASCII without needing word segmentation.
pub(super) fn fts_phrase(q: &str) -> String {
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
pub(super) fn rebuild_fts_index_sql(conn: &Connection) -> Result<usize> {
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
pub(super) fn searchable_text(ev: &AgentEvent) -> Option<(String, &'static str)> {
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
