//! Terminal probing and "open a new terminal, then run a command" — the only
//! place that knows how macOS and Windows differ here. Callers use
//! [`available_terminals`] and [`resume_in_terminal`] without any
//! `#[cfg(target_os = ...)]` of their own.

/// A terminal emulator we know how to drive, surfaced to the frontend so the
/// user can pick where a session resumes.
#[derive(serde::Serialize)]
pub struct TerminalApp {
    id: String,
    name: String,
}

/// Probe the system for terminal emulators we know how to drive.
/// macOS prefers iTerm when present and falls back to Terminal.app.
/// Windows prefers Windows Terminal when present and falls back to PowerShell.
pub fn available_terminals() -> Vec<TerminalApp> {
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
    #[cfg(target_os = "windows")]
    {
        let mut out = Vec::new();
        if command_exists("wt.exe") {
            out.push(TerminalApp {
                id: "windows-terminal".into(),
                name: "Windows Terminal".into(),
            });
        }
        if command_exists("powershell.exe") {
            out.push(TerminalApp {
                id: "powershell".into(),
                name: "PowerShell".into(),
            });
        }
        out
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn command_exists(name: &str) -> bool {
    std::process::Command::new("where")
        .arg(name)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Build the proxy URL the shell should export. Bare `host:port` is treated
/// as `http://host:port` (Clash/V2Ray default); anything with a scheme is
/// passed through. Returns `None` on empty/whitespace input.
#[cfg(any(target_os = "macos", target_os = "windows"))]
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
#[cfg(target_os = "macos")]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

#[cfg(target_os = "windows")]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Optional proxy export — set both upper- and lower-case names so tools that
/// read either convention pick it up.
#[cfg(target_os = "macos")]
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

#[cfg(target_os = "windows")]
fn build_windows_proxy_prefix(proxy: Option<&str>) -> String {
    proxy
        .and_then(normalize_proxy)
        .map(|url| {
            let q = ps_quote(&url);
            format!(
                "$env:HTTP_PROXY = {url}; $env:HTTPS_PROXY = {url}; \
                 $env:ALL_PROXY = {url}; $env:http_proxy = {url}; \
                 $env:https_proxy = {url}; $env:all_proxy = {url}; ",
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

/// Drive Windows Terminal/PowerShell to open a new window and run `shell_cmd`.
#[cfg(target_os = "windows")]
fn run_in_terminal(shell_cmd: &str, cwd: &str, terminal: Option<&str>) -> Result<(), String> {
    match terminal.unwrap_or("windows-terminal") {
        "powershell" => {
            std::process::Command::new("powershell.exe")
                .arg("-NoExit")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-Command")
                .arg(shell_cmd)
                .current_dir(cwd)
                .spawn()
                .map_err(|e| format!("failed to launch PowerShell: {}", e))?;
        }
        // Backward-compatible fallback for callers that still pass "terminal"
        // as the default terminal id.
        "windows-terminal" | "terminal" | "iterm" => {
            if command_exists("wt.exe") {
                std::process::Command::new("wt.exe")
                    .arg("-d")
                    .arg(cwd)
                    .arg("powershell.exe")
                    .arg("-NoExit")
                    .arg("-ExecutionPolicy")
                    .arg("Bypass")
                    .arg("-Command")
                    .arg(shell_cmd)
                    .spawn()
                    .map_err(|e| format!("failed to launch Windows Terminal: {}", e))?;
            } else {
                std::process::Command::new("powershell.exe")
                    .arg("-NoExit")
                    .arg("-ExecutionPolicy")
                    .arg("Bypass")
                    .arg("-Command")
                    .arg(shell_cmd)
                    .current_dir(cwd)
                    .spawn()
                    .map_err(|e| format!("failed to launch PowerShell: {}", e))?;
            }
        }
        other => return Err(format!("Unsupported terminal: {}", other)),
    }
    Ok(())
}

/// Open a new terminal window in `cwd` and run `bin` followed by `args`
/// (e.g. `claude --resume <id>` or `codex resume <id>`). When `proxy` is set,
/// the relevant `*_PROXY` env vars are exported first. All macOS/Windows
/// differences — argument quoting, proxy syntax, how the terminal is launched
/// — are handled here so callers stay platform-agnostic.
pub fn resume_in_terminal(
    cwd: &str,
    bin: &str,
    args: &[&str],
    terminal: Option<&str>,
    proxy: Option<&str>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let args_q = args
            .iter()
            .map(|&a| sh_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        let shell_cmd = format!(
            "cd {} && {}{} {}",
            sh_quote(cwd),
            build_proxy_prefix(proxy),
            bin,
            args_q,
        );
        run_in_terminal(&shell_cmd, terminal)
    }
    #[cfg(target_os = "windows")]
    {
        let args_q = args
            .iter()
            .map(|&a| ps_quote(a))
            .collect::<Vec<_>>()
            .join(" ");
        let shell_cmd = format!(
            "Set-Location -LiteralPath {}; {}{} {}",
            ps_quote(cwd),
            build_windows_proxy_prefix(proxy),
            bin,
            args_q,
        );
        run_in_terminal(&shell_cmd, cwd, terminal)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (cwd, bin, args, terminal, proxy);
        Err("Resume in Terminal is only supported on macOS and Windows for now".into())
    }
}
