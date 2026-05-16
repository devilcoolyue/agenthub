mod agent;
mod backfill;
mod db;
mod policy;

use agent::{AgentEvent, Source, Tailer};
use backfill::BackfillProgress;
use db::{DailyCost, Db, ModelCost, SessionCategory, SessionSummary, SessionsFilter};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

struct BackfillGuard(Arc<AtomicBool>);

#[tauri::command]
fn get_recent_events(state: State<'_, Arc<Db>>, limit: Option<usize>) -> Vec<AgentEvent> {
    state
        .recent(limit.unwrap_or(500))
        .unwrap_or_default()
}

#[tauri::command]
fn get_event_count(state: State<'_, Arc<Db>>) -> i64 {
    state.count().unwrap_or(0)
}

#[tauri::command]
fn list_sessions(
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
fn list_session_categories(state: State<'_, Arc<Db>>) -> Vec<SessionCategory> {
    state.list_session_categories().unwrap_or_default()
}

#[tauri::command]
fn get_session_events(state: State<'_, Arc<Db>>, session_id: String) -> Vec<AgentEvent> {
    state.session_events(&session_id).unwrap_or_default()
}

#[tauri::command]
fn get_daily_cost(state: State<'_, Arc<Db>>, days: Option<usize>) -> Vec<DailyCost> {
    state.daily_cost(days.unwrap_or(30)).unwrap_or_default()
}

#[tauri::command]
fn get_model_cost(state: State<'_, Arc<Db>>, days: Option<usize>) -> Vec<ModelCost> {
    state.model_cost(days.unwrap_or(30)).unwrap_or_default()
}

#[tauri::command]
fn get_agent_policies() -> Vec<policy::AgentPolicy> {
    policy::read_all()
}

#[tauri::command]
fn remove_policy_item(action: policy::RemoveAction) -> Result<(), String> {
    policy::apply_remove(&action).map_err(|e| e.to_string())
}

#[tauri::command]
fn remove_policy_items(actions: Vec<policy::RemoveAction>) -> Result<policy::BatchResult, String> {
    policy::apply_remove_batch(&actions).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_policy_backups(limit: Option<usize>) -> Vec<policy::BackupInfo> {
    policy::list_recent_backups(limit.unwrap_or(20))
}

#[tauri::command]
fn restore_policy_backup(backup_path: String, original_path: String) -> Result<(), String> {
    policy::restore_backup(&backup_path, &original_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn start_backfill(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    guard: State<'_, BackfillGuard>,
) -> Result<(), String> {
    // single-flight
    if guard.0.swap(true, Ordering::SeqCst) {
        return Err("backfill already running".into());
    }
    let db = db.inner().clone();
    let flag = guard.0.clone();
    let app2 = app.clone();
    thread::spawn(move || {
        let emit = |p: BackfillProgress| {
            let _ = app2.emit("backfill-progress", &p);
        };
        if let Err(e) = backfill::run(&db, emit) {
            let _ = app2.emit(
                "backfill-progress",
                &BackfillProgress::Failed {
                    error: e.to_string(),
                },
            );
        }
        flag.store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn spawn_tail(app: AppHandle, db: Arc<Db>) {
    thread::spawn(move || {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return,
        };
        let claude_root = home.join(".claude/projects");
        let codex_root = home.join(".codex/sessions");

        // tail mode: only new activity from sessions touched in the last 24h
        let mut tailer = Tailer::new(true, Some(60 * 60 * 24));
        tailer.scan_dir(&claude_root, Source::ClaudeCode);
        tailer.scan_dir(&codex_root, Source::Codex);

        loop {
            tailer.scan_dir(&claude_root, Source::ClaudeCode);
            tailer.scan_dir(&codex_root, Source::Codex);
            let _ = tailer.poll(|ev| {
                let _ = db.insert(&ev);
                let _ = app.emit("agent-event", &ev);
            });
            thread::sleep(Duration::from_millis(500));
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(move |app| {
            let dir = app
                .path()
                .app_data_dir()
                .expect("resolve app data dir");
            let db_path = dir.join("events.db");
            let db = Arc::new(Db::open(&db_path).expect("open events.db"));
            app.manage(db.clone());
            app.manage(BackfillGuard(Arc::new(AtomicBool::new(false))));
            spawn_tail(app.handle().clone(), db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_recent_events,
            get_event_count,
            list_sessions,
            list_session_categories,
            get_session_events,
            get_daily_cost,
            get_model_cost,
            get_agent_policies,
            remove_policy_item,
            remove_policy_items,
            list_policy_backups,
            restore_policy_backup,
            start_backfill
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
