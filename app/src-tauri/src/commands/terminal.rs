use std::path::{Path, PathBuf};

use crate::platform::terminal::{available_terminals, resume_in_terminal, TerminalApp};

/// List the terminal emulators we can drive on this OS. Thin wrapper over the
/// platform layer so the Tauri command surface stays here.
#[tauri::command]
pub fn list_available_terminals() -> Vec<TerminalApp> {
    available_terminals()
}

fn claude_cwd_candidates(encoded: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(PathBuf::from(encoded));
    out.push(PathBuf::from(encoded.replace('-', "/")));

    #[cfg(target_os = "windows")]
    {
        let win = encoded.replace('-', "\\");
        out.push(PathBuf::from(&win));

        if let Some(drive) = encoded.chars().next().filter(|c| c.is_ascii_alphabetic()) {
            let rest = &encoded[drive.len_utf8()..];
            let rest = rest.trim_start_matches(|c| c == '-' || c == ':' || c == '\\' || c == '/');
            if !rest.is_empty() {
                let rest = rest.replace('-', "\\").replace('/', "\\");
                out.push(PathBuf::from(format!(
                    "{}:\\{}",
                    drive.to_ascii_uppercase(),
                    rest.trim_start_matches('\\')
                )));
            }
        }
    }

    out
}

/// Walk `~/.claude/projects/*/` looking for `<session_id>.jsonl`. The parent
/// directory name encodes the session's launch cwd with `/` replaced by `-`
/// (e.g. `-Users-foo-bar` → `/Users/foo/bar`). Returns the decoded path only
/// when it points at a real directory — guarding against ambiguous decodes
/// when the original path contained literal dashes.
fn resolve_claude_launch_cwd(session_id: &str) -> Option<String> {
    let projects = dirs::home_dir()?.join(".claude").join("projects");
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
        for decoded in claude_cwd_candidates(&encoded) {
            if decoded.is_dir() {
                return Some(decoded.display().to_string());
            }
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
    let root = dirs::home_dir()?.join(".codex").join("sessions");
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

#[tauri::command]
pub fn resume_claude_session(
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
        .or_else(|| cwd.filter(|s| !s.is_empty() && Path::new(s).is_dir()))
        .ok_or_else(|| "Could not locate the session's launch directory on disk".to_string())?;

    resume_in_terminal(
        &cwd,
        "claude",
        &["--resume", session_id.as_str()],
        terminal.as_deref(),
        proxy.as_deref(),
    )
}

/// Open a new terminal in the codex session's launch directory and run
/// `codex resume <session_id>`. Codex accepts a UUID as the resume argument
/// (see `codex resume --help`), so we validate the id is hex/dash only.
#[tauri::command]
pub fn resume_codex_session(
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
        .or_else(|| cwd.filter(|s| !s.is_empty() && Path::new(s).is_dir()))
        .ok_or_else(|| "Could not locate the session's launch directory on disk".to_string())?;

    resume_in_terminal(
        &cwd,
        "codex",
        &["resume", session_id.as_str()],
        terminal.as_deref(),
        proxy.as_deref(),
    )
}
