use crate::agent::AgentEvent;
use crate::db::Db;
use std::sync::Arc;
use tauri::State;

#[derive(serde::Serialize)]
pub struct PurgeResult {
    deleted: i64,
    freed_bytes: i64,
}

#[tauri::command]
pub fn get_recent_events(state: State<'_, Arc<Db>>, limit: Option<usize>) -> Vec<AgentEvent> {
    state.recent(limit.unwrap_or(500)).unwrap_or_default()
}

#[tauri::command]
pub fn get_event_count(state: State<'_, Arc<Db>>) -> i64 {
    state.count().unwrap_or(0)
}

#[tauri::command]
pub fn get_db_size(state: State<'_, Arc<Db>>) -> i64 {
    state.size_bytes().unwrap_or(0)
}

#[tauri::command]
pub fn purge_events(state: State<'_, Arc<Db>>, days: u32) -> Result<PurgeResult, String> {
    state
        .purge_older_than(days)
        .map(|(deleted, freed)| PurgeResult {
            deleted,
            freed_bytes: freed.max(0),
        })
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_session_events(state: State<'_, Arc<Db>>, session_id: String) -> Vec<AgentEvent> {
    state.session_events(&session_id).unwrap_or_default()
}

#[tauri::command]
pub fn rebuild_fts_index(db: State<'_, Arc<Db>>) -> Result<usize, String> {
    db.backfill_fts().map_err(|e| e.to_string())
}

/// Returns a short reason string when a migration has flagged that a fresh
/// backfill is needed (e.g. "codex_model_recovery"). The frontend uses this
/// to auto-trigger backfill at launch even when the DB is not empty.
#[tauri::command]
pub fn get_pending_backfill(state: State<'_, Arc<Db>>) -> Option<String> {
    state.kv_get("pending_backfill")
}
