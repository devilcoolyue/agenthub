mod agent;
mod backfill;
mod commands;
mod db;
mod platform;
mod policy;

use agent::{Source, Tailer};
use commands::BackfillGuard;
use db::Db;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// Background tail loop: scans the JSONL roots Claude Code and Codex write
/// to, polls them for new events, persists each event to the local DB, and
/// re-emits it as `agent-event` for the frontend's live activity feed.
fn spawn_tail(app: AppHandle, db: Arc<Db>) {
    thread::spawn(move || {
        let home = match dirs::home_dir() {
            Some(h) => h,
            None => return,
        };
        let claude_root = home.join(".claude").join("projects");
        let codex_root = home.join(".codex").join("sessions");

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
    use commands::{cost, events, policy as policy_cmds, sessions, terminal};

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
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
            events::get_recent_events,
            events::get_event_count,
            events::get_db_size,
            events::purge_events,
            events::get_session_events,
            events::rebuild_fts_index,
            events::get_pending_backfill,
            sessions::list_sessions,
            sessions::list_session_categories,
            cost::get_daily_cost,
            cost::get_model_cost,
            cost::get_session_usage,
            cost::get_today_agent_stats,
            policy_cmds::get_agent_policies,
            policy_cmds::remove_policy_item,
            policy_cmds::remove_policy_items,
            policy_cmds::list_policy_backups,
            policy_cmds::restore_policy_backup,
            commands::backfill::start_backfill,
            terminal::resume_claude_session,
            terminal::resume_codex_session,
            terminal::list_available_terminals,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
