use crate::backfill::{self, BackfillProgress};
use crate::db::Db;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

/// Single-flight latch — prevents two backfills running concurrently.
pub struct BackfillGuard(pub Arc<AtomicBool>);

#[tauri::command]
pub fn start_backfill(
    app: AppHandle,
    db: State<'_, Arc<Db>>,
    guard: State<'_, BackfillGuard>,
) -> Result<(), String> {
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
