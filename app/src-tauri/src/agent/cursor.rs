//! Cursor session ingest (read-only).
//!
//! Unlike Claude Code / Codex, Cursor does NOT write append-only JSONL — all
//! chat lives in a SQLite KV database, so it can't be tailed line-by-line. We
//! open it read-only and reconstruct sessions. Format notes (from probing the
//! on-disk schema):
//!   - `cursorDiskKV.composerData:<id>` = one session (name, createdAt,
//!     lastUpdatedAt, status, modelConfig …).
//!   - `cursorDiskKV.bubbleId:<id>:<b>` = one message. Order is the session's
//!     `fullConversationHeadersOnly` (older sessions instead inline a
//!     `conversation` array).
//!   - cwd: the global DB doesn't reliably hold it; we map composerId → project
//!     folder via each `workspaceStorage/<hash>/{workspace.json, state.vscdb}`.
//!   - per-message model / tokens / cost are resolved SERVER-SIDE (bubbles only
//!     keep a `modelCallId`/`usageUuid` pointer), so model is best-effort
//!     session-level and cost is always 0/absent here.
//!
//! Timestamps: each bubble carries its own `createdAt` wall clock — the real
//! per-message time — which we use directly (with a sub-ms counter for the rare
//! multi-event bubble). It's stable, so re-ingesting a grown session stays
//! idempotent under the event-hash dedupe. Older bubbles that predate the field
//! fall back to the composer `createdAt + n ms` synthetic clock. SessionStart
//! and the sessions-row bounds anchor to the first/last real message rather than
//! the composer's `createdAt`, which can be days stale for a session first used
//! much later.

use super::event::{Agent, AgentEvent, EventKind};
use super::risk;
use anyhow::{Context, Result};
use chrono::{DateTime, Duration, TimeZone, Utc};
use rusqlite::{params, Connection, OpenFlags};
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// How far back (ms) a session's `lastUpdatedAt` may be and still get re-scanned
/// on every poll, independent of the watermark. `lastUpdatedAt` is not a
/// reliable "new content" marker — Cursor streams an assistant reply *after* the
/// user's turn without always advancing it, so a strict `> watermark` check
/// drops that reply. Re-reading a recently-active session is cheap and the
/// per-event hash dedupe makes it idempotent.
const ACTIVE_RESCAN_MS: i64 = 15 * 60 * 1000;

/// One reconstructed Cursor session, ready to persist.
pub struct CursorSession {
    pub composer_id: String,
    pub start: DateTime<Utc>,
    pub end: DateTime<Utc>,
    pub events: Vec<AgentEvent>,
}

/// `~/Library/Application Support/Cursor/...` (macOS), `~/.config/Cursor/...`
/// (Linux), `%APPDATA%/Cursor/...` (Windows) — `dirs::config_dir()` matches
/// VS Code's per-OS base, which Cursor inherits.
pub fn global_db_path() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("Cursor")
            .join("User")
            .join("globalStorage")
            .join("state.vscdb"),
    )
}

fn workspace_storage_dir() -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join("Cursor")
            .join("User")
            .join("workspaceStorage"),
    )
}

/// Open a Cursor DB read-only. We never write, never take a write lock, and
/// never touch Cursor's WAL — safe to run while Cursor is open.
fn open_ro(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .with_context(|| format!("open cursor db (ro) {}", path.display()))
}

/// Walk the global composerData rows; for each session whose `lastUpdatedAt`
/// is newer than `watermark_ms`, rebuild it and hand it to `on_session`.
/// Returns the new high-water mark (max lastUpdatedAt seen) to persist.
///
/// The cheap `json_extract` pre-pass means unchanged sessions cost only a
/// SQLite-side field read — we only pull & parse the full ~MB blob for
/// sessions that actually changed.
pub fn collect(watermark_ms: i64, mut on_session: impl FnMut(CursorSession)) -> Result<i64> {
    let Some(path) = global_db_path() else {
        return Ok(watermark_ms);
    };
    if !path.exists() {
        return Ok(watermark_ms);
    }
    let conn = open_ro(&path)?;
    let cwd_map = build_cwd_map();

    // 1) cheap pass: (key, lastUpdatedAt, createdAt) without parsing blobs.
    let changed: Vec<(String, i64, i64)> = {
        let mut stmt = conn.prepare(
            "SELECT key, \
                    CAST(json_extract(value,'$.lastUpdatedAt') AS INTEGER), \
                    CAST(json_extract(value,'$.createdAt') AS INTEGER) \
             FROM cursorDiskKV WHERE key LIKE 'composerData:%'",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<i64>>(1)?,
                r.get::<_, Option<i64>>(2)?,
            ))
        })?;
        let active_floor = Utc::now().timestamp_millis() - ACTIVE_RESCAN_MS;
        rows.filter_map(|r| r.ok())
            .filter_map(|(k, upd, crt)| {
                let last = upd.or(crt)?;
                let created = crt.or(upd)?;
                // New since last time, OR active recently enough that a
                // late-streamed reply may have landed without bumping the mark.
                (last > watermark_ms || last >= active_floor).then_some((k, last, created))
            })
            .collect()
    };

    let mut new_watermark = watermark_ms;
    let mut get_blob = conn.prepare("SELECT value FROM cursorDiskKV WHERE key = ?1")?;
    let mut get_bubbles =
        conn.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE ?1")?;

    for (key, last, created) in changed {
        if last > new_watermark {
            new_watermark = last;
        }
        // cursorDiskKV.value is TEXT (JSON), so read it as a String.
        let Ok(text) = get_blob.query_row(params![key], |r| r.get::<_, String>(0)) else {
            continue;
        };
        let Ok(d) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if let Some(session) =
            build_session(&mut get_bubbles, &d, &key, created, last, &cwd_map)
        {
            // Skip empty drafts (a composer with no messages — only the
            // synthetic SessionStart). Also covers sessions whose bubble rows
            // couldn't be read: nothing to show either way.
            let has_message = session
                .events
                .iter()
                .any(|e| !matches!(e.kind, EventKind::SessionStart { .. }));
            if has_message {
                on_session(session);
            }
        }
    }
    Ok(new_watermark)
}

fn build_session(
    get_bubbles: &mut rusqlite::Statement,
    d: &Value,
    key: &str,
    created_ms: i64,
    updated_ms: i64,
    cwd_map: &HashMap<String, String>,
) -> Option<CursorSession> {
    let composer_id = d
        .get("composerId")
        .and_then(|x| x.as_str())
        .unwrap_or_else(|| key.strip_prefix("composerData:").unwrap_or(key))
        .to_string();

    let cwd = cwd_map.get(&composer_id).cloned().or_else(|| {
        // fallback: a few sessions carry their own workspaceIdentifier.uri.path
        d.get("workspaceIdentifier")
            .and_then(|w| w.get("uri"))
            .and_then(|u| u.get("path"))
            .and_then(|p| p.as_str())
            .map(|s| s.to_string())
    });
    let model = d
        .get("modelConfig")
        .and_then(|m| m.get("modelName"))
        .and_then(|x| x.as_str())
        .filter(|m| !m.is_empty())
        .map(|s| s.to_string());

    let start = Utc.timestamp_millis_opt(created_ms).single()?;
    let end = Utc
        .timestamp_millis_opt(updated_ms.max(created_ms))
        .single()
        .unwrap_or(start);

    let mut events: Vec<AgentEvent> = Vec::new();
    let mut idx: i64 = 0;

    // Message order: prefer the explicit header list (newer sessions store each
    // bubble in its own row); fall back to the inline conversation array.
    match d
        .get("fullConversationHeadersOnly")
        .and_then(|x| x.as_array())
        .filter(|h| !h.is_empty())
    {
        Some(headers) => {
            let bubbles = fetch_bubbles(get_bubbles, &composer_id);
            for h in headers {
                if let Some(bid) = h.get("bubbleId").and_then(|x| x.as_str()) {
                    if let Some(b) = bubbles.get(bid) {
                        emit_bubble(b, &mut events, &mut idx, start, &composer_id, &cwd);
                    }
                }
            }
        }
        None => {
            if let Some(conv) = d.get("conversation").and_then(|x| x.as_array()) {
                for b in conv {
                    emit_bubble(b, &mut events, &mut idx, start, &composer_id, &cwd);
                }
            }
        }
    }

    // SessionStart anchors to the first real message's wall clock, not the
    // composer's `createdAt` (which can be days stale for a session first used
    // much later). Prepend it so it leads the conversation.
    let first_ts = events.iter().map(|e| e.timestamp).min();
    let session_ts = first_ts
        .map(|t| t - Duration::milliseconds(1))
        .unwrap_or(start);
    events.insert(
        0,
        AgentEvent {
            agent: Agent::Cursor,
            session_id: composer_id.clone(),
            cwd: cwd.clone(),
            timestamp: session_ts,
            kind: EventKind::SessionStart { model, version: None },
            risk_tags: Vec::new(),
            usage: None,
        },
    );

    // Bounds come from the message wall clocks; `lastUpdatedAt` lags (it doesn't
    // advance while a reply streams), so widen `end` past it when needed.
    let real_start = events.first().map(|e| e.timestamp).unwrap_or(start);
    let real_end = events
        .iter()
        .map(|e| e.timestamp)
        .max()
        .map(|t| t.max(end))
        .unwrap_or(end);

    Some(CursorSession {
        composer_id,
        start: real_start,
        end: real_end,
        events,
    })
}

/// Bulk-fetch every bubble row for one composer into a `bubbleId → value` map.
fn fetch_bubbles(stmt: &mut rusqlite::Statement, composer_id: &str) -> HashMap<String, Value> {
    let like = format!("bubbleId:{composer_id}:%");
    let mut map = HashMap::new();
    if let Ok(rows) = stmt.query_map(params![like], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    }) {
        for (k, text) in rows.flatten() {
            // key = bubbleId:<composerId>:<bubbleId>; composerId has no ':'
            if let Some(bid) = k.rsplit(':').next() {
                if let Ok(v) = serde_json::from_str::<Value>(&text) {
                    map.insert(bid.to_string(), v);
                }
            }
        }
    }
    map
}

fn emit_bubble(
    b: &Value,
    events: &mut Vec<AgentEvent>,
    idx: &mut i64,
    start: DateTime<Utc>,
    composer_id: &str,
    cwd: &Option<String>,
) {
    let btype = b.get("type").and_then(|x| x.as_i64()).unwrap_or(0);
    let text = b
        .get("text")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    // Prefer the bubble's own `createdAt` (real per-message time); fall back to
    // the creation-anchored synthetic clock only for older bubbles that lack it.
    // A sub-ms counter keeps the rare multi-event bubble (assistant text + a
    // tool call) ordered and hash-distinct.
    let base = bubble_created(b).unwrap_or_else(|| start + Duration::milliseconds(*idx));
    *idx += 1;
    let mut sub: i64 = 0;
    let mut next_ts = || {
        let t = base + Duration::milliseconds(sub);
        sub += 1;
        t
    };

    match btype {
        1 => {
            if !text.is_empty() {
                let ts = next_ts();
                push_event(events, composer_id, cwd, EventKind::UserPrompt { text }, ts);
            }
        }
        2 => {
            if !text.is_empty() {
                let ts = next_ts();
                push_event(events, composer_id, cwd, EventKind::AssistantText { text }, ts);
            }
            if let Some(tfd) = b.get("toolFormerData").and_then(|x| x.as_object()) {
                if let Some(name) = tfd.get("name").and_then(|x| x.as_str()) {
                    let raw_input = parse_tool_args(tfd);
                    let summary = summarize_tool(name, &raw_input);
                    let ts = next_ts();
                    push_event(
                        events,
                        composer_id,
                        cwd,
                        EventKind::ToolUse {
                            name: name.to_string(),
                            summary,
                            raw_input,
                        },
                        ts,
                    );
                    let (ok, rsummary) = tool_result(tfd);
                    let ts = next_ts();
                    push_event(
                        events,
                        composer_id,
                        cwd,
                        EventKind::ToolResult {
                            ok,
                            summary: rsummary,
                        },
                        ts,
                    );
                }
            }
        }
        _ => {}
    }
}

fn push_event(
    events: &mut Vec<AgentEvent>,
    composer_id: &str,
    cwd: &Option<String>,
    kind: EventKind,
    timestamp: DateTime<Utc>,
) {
    let risk_tags = risk::score(&kind);
    events.push(AgentEvent {
        agent: Agent::Cursor,
        session_id: composer_id.to_string(),
        cwd: cwd.clone(),
        timestamp,
        kind,
        risk_tags,
        usage: None, // Cursor bills server-side; no local token/cost data
    });
}

/// A bubble's own `createdAt` (RFC-3339) — the real per-message wall clock.
/// Newer Cursor builds write it; older bubbles may not, hence `Option`.
fn bubble_created(b: &Value) -> Option<DateTime<Utc>> {
    b.get("createdAt")
        .and_then(|x| x.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

/// `toolFormerData.rawArgs` / `.params` are JSON *strings*; parse to a Value so
/// risk scoring and summaries can read fields (`command`, `target_file`, …).
fn parse_tool_args(tfd: &Map<String, Value>) -> Value {
    for k in ["rawArgs", "params"] {
        if let Some(s) = tfd.get(k).and_then(|x| x.as_str()) {
            if let Ok(v) = serde_json::from_str::<Value>(s) {
                return v;
            }
        }
    }
    Value::Null
}

fn tool_result(tfd: &Map<String, Value>) -> (bool, String) {
    if let Some(err) = tfd.get("error") {
        if !err.is_null() {
            let msg = err.as_str().map(|s| s.to_string()).unwrap_or_else(|| err.to_string());
            return (false, short(&format!("error: {msg}"), 120));
        }
    }
    let status = tfd.get("status").and_then(|x| x.as_str()).unwrap_or("");
    (status != "error", status.to_string())
}

fn summarize_tool(name: &str, args: &Value) -> String {
    // Cursor tools use many different arg keys (and `_v2` variants); try them
    // in priority order — shell command, then file path, then a query term.
    let detail = [
        "command",
        "file_path",
        "target_file",
        "relativeWorkspacePath",
        "relative_workspace_path",
        "query",
        "pattern",
        "search_term",
        "glob_pattern",
        "path",
        "target_directory",
    ]
    .iter()
    .find_map(|k| args.get(*k).and_then(|x| x.as_str()))
    .map(str::trim)
    .filter(|s| !s.is_empty());
    match detail {
        Some(d) => short(&format!("{name}: {d}"), 120),
        None => name.to_string(),
    }
}

/// Map composerId → project folder by reading each workspace's
/// `workspace.json` (the folder URI) plus its `state.vscdb`
/// `composer.composerData.allComposers[].composerId` (which composers live there).
fn build_cwd_map() -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(root) = workspace_storage_dir() else {
        return map;
    };
    let Ok(entries) = std::fs::read_dir(&root) else {
        return map;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Some(folder) = std::fs::read_to_string(dir.join("workspace.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| {
                v.get("folder")
                    .and_then(|f| f.as_str())
                    .map(|s| uri_to_path(s))
            })
        else {
            continue;
        };
        let db = dir.join("state.vscdb");
        if !db.exists() {
            continue;
        }
        let Ok(conn) = open_ro(&db) else {
            continue;
        };
        let blob: Option<String> = conn
            .query_row(
                "SELECT value FROM ItemTable WHERE key='composer.composerData'",
                [],
                |r| r.get(0),
            )
            .ok();
        if let Some(text) = blob {
            if let Ok(v) = serde_json::from_str::<Value>(&text) {
                if let Some(arr) = v.get("allComposers").and_then(|a| a.as_array()) {
                    for c in arr {
                        if let Some(id) = c.get("composerId").and_then(|x| x.as_str()) {
                            map.insert(id.to_string(), folder.clone());
                        }
                    }
                }
            }
        }
    }
    map
}

/// `file:///Users/me/p` → `/Users/me/p`, with minimal percent-decoding.
fn uri_to_path(uri: &str) -> String {
    let s = uri.strip_prefix("file://").unwrap_or(uri);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(n).collect();
        t.push('…');
        t
    }
}
