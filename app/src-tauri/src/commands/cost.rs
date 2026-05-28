use crate::db::{AgentDayStat, DailyCost, Db, ModelCost, ModelUsage};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub fn get_daily_cost(state: State<'_, Arc<Db>>, days: Option<usize>) -> Vec<DailyCost> {
    state.daily_cost(days.unwrap_or(30)).unwrap_or_default()
}

#[tauri::command]
pub fn get_model_cost(state: State<'_, Arc<Db>>, days: Option<usize>) -> Vec<ModelCost> {
    state.model_cost(days.unwrap_or(30)).unwrap_or_default()
}

#[tauri::command]
pub fn get_session_usage(state: State<'_, Arc<Db>>, session_id: String) -> Vec<ModelUsage> {
    state.session_usage(&session_id).unwrap_or_default()
}

#[tauri::command]
pub fn get_today_agent_stats(state: State<'_, Arc<Db>>) -> Vec<AgentDayStat> {
    state.today_agent_stats().unwrap_or_default()
}
