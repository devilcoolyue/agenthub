mod agent;
mod backfill;
mod db;
mod policy;

use agent::{AgentEvent, Source, Tailer};
use backfill::BackfillProgress;
use db::{DailyCost, Db, ModelCost, ModelUsage, SessionCategory, SessionSummary, SessionsFilter};
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
fn get_db_size(state: State<'_, Arc<Db>>) -> i64 {
    state.size_bytes().unwrap_or(0)
}

#[derive(serde::Serialize)]
struct PurgeResult {
    deleted: i64,
    freed_bytes: i64,
}

#[tauri::command]
fn purge_events(state: State<'_, Arc<Db>>, days: u32) -> Result<PurgeResult, String> {
    state
        .purge_older_than(days)
        .map(|(deleted, freed)| PurgeResult {
            deleted,
            freed_bytes: freed.max(0),
        })
        .map_err(|e| e.to_string())
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
fn get_session_usage(state: State<'_, Arc<Db>>, session_id: String) -> Vec<ModelUsage> {
    state.session_usage(&session_id).unwrap_or_default()
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
fn rebuild_fts_index(db: State<'_, Arc<Db>>) -> Result<usize, String> {
    db.backfill_fts().map_err(|e| e.to_string())
}

/// Returns a short reason string when a migration has flagged that a fresh
/// backfill is needed (e.g. "codex_model_recovery"). The frontend uses this
/// to auto-trigger backfill at launch even when the DB is not empty.
#[tauri::command]
fn get_pending_backfill(state: State<'_, Arc<Db>>) -> Option<String> {
    state.kv_get("pending_backfill")
}

/// Walk `~/.claude/projects/*/` looking for `<session_id>.jsonl`. The parent
/// directory name encodes the session's launch cwd with `/` replaced by `-`
/// (e.g. `-Users-foo-bar` → `/Users/foo/bar`). Returns the decoded path only
/// when it points at a real directory — guarding against ambiguous decodes
/// when the original path contained literal dashes.
fn resolve_claude_launch_cwd(session_id: &str) -> Option<String> {
    let projects = dirs::home_dir()?.join(".claude/projects");
    let entries = std::fs::read_dir(&projects).ok()?;
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let session_file = dir.join(format!("{}.jsonl", session_id));
        if !session_file.is_file() {
            continue;
        }
        let encoded = entry.file_name().to_string_lossy().to_string();
        let decoded = encoded.replace('-', "/");
        if std::path::Path::new(&decoded).is_dir() {
            return Some(decoded);
        }
        // Decode hit a dash-vs-slash ambiguity; bail to fallback rather than
        // launching in some unrelated directory.
        return None;
    }
    None
}

/// Walk `~/.codex/sessions/**` for `rollout-<ts>-<session_id>.jsonl` and pull
/// the launch cwd from the first `session_meta` record. Codex writes the cwd
/// at the top of every rollout file, so this is authoritative even if the
/// session later `cd`'d elsewhere.
fn resolve_codex_launch_cwd(session_id: &str) -> Option<String> {
    let root = dirs::home_dir()?.join(".codex/sessions");
    if !root.is_dir() {
        return None;
    }
    let needle = format!("-{}.jsonl", session_id);
    for entry in walkdir::WalkDir::new(&root)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if !name.ends_with(&needle) {
            continue;
        }
        let file = std::fs::File::open(entry.path()).ok()?;
        let mut reader = std::io::BufReader::new(file);
        let mut line = String::new();
        use std::io::BufRead;
        if reader.read_line(&mut line).ok()? == 0 {
            return None;
        }
        let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
        if v.get("type").and_then(|x| x.as_str()) != Some("session_meta") {
            return None;
        }
        return v
            .get("payload")
            .and_then(|p| p.get("cwd"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
            .filter(|s| std::path::Path::new(s).is_dir());
    }
    None
}

#[derive(serde::Serialize)]
struct TerminalApp {
    id: String,
    name: String,
}

/// Probe the system for terminal emulators we know how to drive. iTerm2 is
/// listed first when present so the UI can default to it; Terminal.app is
/// always present on macOS and acts as the fallback.
#[tauri::command]
fn list_available_terminals() -> Vec<TerminalApp> {
    #[cfg(target_os = "macos")]
    {
        let mut out = Vec::new();
        if std::path::Path::new("/Applications/iTerm.app").exists() {
            out.push(TerminalApp {
                id: "iterm".into(),
                name: "iTerm".into(),
            });
        }
        out.push(TerminalApp {
            id: "terminal".into(),
            name: "Terminal".into(),
        });
        out
    }
    #[cfg(not(target_os = "macos"))]
    {
        Vec::new()
    }
}

/// Open a new terminal window cd'd to the session's original launch
/// directory and run `claude --resume <session_id>`. Claude Code files
/// sessions under `~/.claude/projects/<encoded-launch-cwd>/<id>.jsonl`, so
/// launching from the wrong directory would mean Claude can't locate the
/// session even though the id is globally unique on disk.
///
/// The frontend can pass a `cwd` (best-effort, taken from event metadata),
/// but we prefer the on-disk JSONL location because event-cwd drifts when
/// the user `cd`s mid-session.
///
/// `terminal` selects the emulator (e.g. "iterm", "terminal"); when absent
/// we fall back to Terminal.app.
///
/// We validate the session id (hex / dash only) to keep the AppleScript
/// payload from doing anything beyond shelling out.
/// Build the proxy URL the shell should export. Bare `host:port` is treated
/// as `http://host:port` (Clash/V2Ray default); anything with a scheme is
/// passed through. Returns `None` on empty/whitespace input.
fn normalize_proxy(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if s.contains("://") {
        Some(s.to_string())
    } else {
        Some(format!("http://{}", s))
    }
}

/// POSIX single-quote: escape ' as '\'' so cwd or id with spaces/quotes can't
/// break out of the literal.
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Optional proxy export — set both upper- and lower-case names so tools that
/// read either convention pick it up.
fn build_proxy_prefix(proxy: Option<&str>) -> String {
    proxy
        .and_then(normalize_proxy)
        .map(|url| {
            let q = sh_quote(&url);
            format!(
                "export HTTP_PROXY={url} HTTPS_PROXY={url} ALL_PROXY={url} \
                 http_proxy={url} https_proxy={url} all_proxy={url} && ",
                url = q
            )
        })
        .unwrap_or_default()
}

/// Drive macOS Terminal/iTerm to open a new window and run `shell_cmd`.
#[cfg(target_os = "macos")]
fn run_in_terminal(shell_cmd: &str, terminal: Option<&str>) -> Result<(), String> {
    // AppleScript string: backslash and double-quote need escaping.
    let as_quote = shell_cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let kind = terminal.unwrap_or("terminal");
    let script = match kind {
        "iterm" => format!(
            "tell application \"iTerm\"\n  activate\n  set newWin to (create window with default profile)\n  tell current session of newWin\n    write text \"{}\"\n  end tell\nend tell",
            as_quote
        ),
        _ => format!(
            "tell application \"Terminal\"\n  activate\n  do script \"{}\"\nend tell",
            as_quote
        ),
    };
    std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .spawn()
        .map_err(|e| format!("failed to launch terminal: {}", e))?;
    Ok(())
}

#[tauri::command]
fn resume_claude_session(
    session_id: String,
    cwd: Option<String>,
    terminal: Option<String>,
    proxy: Option<String>,
) -> Result<(), String> {
    if !session_id
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
        || session_id.is_empty()
    {
        return Err("Invalid session id".into());
    }
    let cwd = resolve_claude_launch_cwd(&session_id)
        .or_else(|| cwd.filter(|s| !s.is_empty() && std::path::Path::new(s).is_dir()))
        .ok_or_else(|| {
            "Could not locate the session's launch directory on disk".to_string()
        })?;

    #[cfg(target_os = "macos")]
    {
        let shell_cmd = format!(
            "cd {} && {}claude --resume {}",
            sh_quote(&cwd),
            build_proxy_prefix(proxy.as_deref()),
            sh_quote(&session_id)
        );
        run_in_terminal(&shell_cmd, terminal.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (cwd, terminal, proxy);
        Err("Resume in Terminal is only supported on macOS for now".into())
    }
}

/// Open a new terminal in the codex session's launch directory and run
/// `codex resume <session_id>`. Codex accepts a UUID as the resume argument
/// (see `codex resume --help`), so we validate the id is hex/dash only.
#[tauri::command]
fn resume_codex_session(
    session_id: String,
    cwd: Option<String>,
    terminal: Option<String>,
    proxy: Option<String>,
) -> Result<(), String> {
    if !session_id
        .chars()
        .all(|c| c.is_ascii_hexdigit() || c == '-')
        || session_id.is_empty()
    {
        return Err("Invalid session id".into());
    }
    let cwd = resolve_codex_launch_cwd(&session_id)
        .or_else(|| cwd.filter(|s| !s.is_empty() && std::path::Path::new(s).is_dir()))
        .ok_or_else(|| {
            "Could not locate the session's launch directory on disk".to_string()
        })?;

    #[cfg(target_os = "macos")]
    {
        let shell_cmd = format!(
            "cd {} && {}codex resume {}",
            sh_quote(&cwd),
            build_proxy_prefix(proxy.as_deref()),
            sh_quote(&session_id)
        );
        run_in_terminal(&shell_cmd, terminal.as_deref())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (cwd, terminal, proxy);
        Err("Resume in Terminal is only supported on macOS for now".into())
    }
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
            get_db_size,
            purge_events,
            list_sessions,
            list_session_categories,
            get_session_events,
            get_daily_cost,
            get_model_cost,
            get_session_usage,
            get_agent_policies,
            remove_policy_item,
            remove_policy_items,
            list_policy_backups,
            restore_policy_backup,
            start_backfill,
            rebuild_fts_index,
            get_pending_backfill,
            resume_claude_session,
            resume_codex_session,
            list_available_terminals
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
