use crate::policy;

#[tauri::command]
pub fn get_agent_policies() -> Vec<policy::AgentPolicy> {
    policy::read_all()
}

#[tauri::command]
pub fn remove_policy_item(action: policy::RemoveAction) -> Result<(), String> {
    policy::apply_remove(&action).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_policy_items(
    actions: Vec<policy::RemoveAction>,
) -> Result<policy::BatchResult, String> {
    policy::apply_remove_batch(&actions).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_policy_backups(limit: Option<usize>) -> Vec<policy::BackupInfo> {
    policy::list_recent_backups(limit.unwrap_or(20))
}

#[tauri::command]
pub fn restore_policy_backup(
    backup_path: String,
    original_path: String,
) -> Result<(), String> {
    policy::restore_backup(&backup_path, &original_path).map_err(|e| e.to_string())
}
