use crate::db::{Db, SessionCategory, SessionSummary, SessionsFilter};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn list_sessions(
    state: State<'_, Arc<Db>>,
    filter: Option<SessionsFilter>,
    limit: Option<usize>,
    offset: Option<usize>,
) -> Vec<SessionSummary> {
    state
        .list_sessions(
            &filter.unwrap_or_default(),
            limit.unwrap_or(20),
            offset.unwrap_or(0),
        )
        .unwrap_or_default()
}

#[tauri::command]
pub fn list_session_categories(state: State<'_, Arc<Db>>) -> Vec<SessionCategory> {
    state.list_session_categories().unwrap_or_default()
}
