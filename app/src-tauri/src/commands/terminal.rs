use std::path::Path;

#[derive(serde::Serialize)]
pub struct TerminalApp {
    id: String,
    name: String,
}

/// Probe the system for terminal emulators we know how to drive. iTerm2 is
/// listed first when present so the UI can default to it; Terminal.app is
/// always present on macOS and acts as the fallback.
#[tauri::command]
pub fn list_available_terminals() -> Vec<TerminalApp> {
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
