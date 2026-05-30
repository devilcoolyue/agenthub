mod agent;
mod backfill;
mod commands;
mod db;
mod platform;
mod policy;

use agent::{Source, Tailer};
use chrono::Utc;
use commands::BackfillGuard;
use db::Db;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager};

/// Newest mtime across a SQLite DB and its WAL sidecars. Cursor runs the DB in
/// WAL mode, so live writes land in `-wal`/`-shm` while the main file only
/// changes on checkpoint (which can lag for days). Gating a poll on the main
/// file alone would miss all activity until a checkpoint — so we take the max
/// across the trio.
fn db_activity_mtime(path: &Path) -> Option<SystemTime> {
    let base = path.as_os_str();
    ["", "-wal", "-shm"]
        .iter()
        .filter_map(|suffix| {
            let mut p = base.to_owned();
            p.push(suffix);
            std::fs::metadata(p).and_then(|m| m.modified()).ok()
        })
        .max()
}

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

/// Cursor stores chat in a SQLite KV store, not tailable JSONL, so it gets its
/// own loop: gate on the DB file's mtime (do nothing while Cursor is idle),
/// and only re-read sessions newer than the persisted watermark. This keeps
/// steady-state cost to a couple of `stat`s — see `agent::cursor`.
fn spawn_cursor_poll(app: AppHandle, db: Arc<Db>) {
    thread::spawn(move || {
        let path = match agent::cursor::global_db_path() {
            Some(p) => p,
            None => return,
        };
        let mut last_mtime: Option<SystemTime> = None;
        loop {
            let mtime = db_activity_mtime(&path);
            if mtime != last_mtime {
                last_mtime = mtime;
                let watermark = db
                    .kv_get("cursor_watermark_ms")
                    .and_then(|s| s.parse::<i64>().ok())
                    .unwrap_or(0);
                let res = agent::cursor::collect(watermark, |s| {
                    let now = Utc::now();
                    for ev in &s.events {
                        if let Ok(true) = db.insert(ev) {
                            // A just-created message (real timestamp within a
                            // couple of minutes) is surfaced to the live feed at
                            // arrival time so the dashboard's brief activity
                            // animation fires — polling can lag the event by a
                            // poll interval, past the animation window. Older
                            // re-imported messages keep their real timestamp. The
                            // persisted DB row is always the real one.
                            if now.signed_duration_since(ev.timestamp).num_seconds() < 120 {
                                let mut shown = ev.clone();
                                shown.timestamp = now;
                                let _ = app.emit("agent-event", &shown);
                            } else {
                                let _ = app.emit("agent-event", ev);
                            }
                        }
                    }
                    let _ = db.set_session_bounds(
                        &s.composer_id,
                        &s.start.to_rfc3339(),
                        &s.end.to_rfc3339(),
                    );
                });
                if let Ok(new_watermark) = res {
                    db.kv_set("cursor_watermark_ms", &new_watermark.to_string());
                }
            }
            thread::sleep(Duration::from_secs(20));
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
            spawn_tail(app.handle().clone(), db.clone());
            spawn_cursor_poll(app.handle().clone(), db);
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
