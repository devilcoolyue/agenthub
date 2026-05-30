use super::event::EventKind;
use serde_json::Value;

const SECRET_HINTS: &[&str] = &[
    ".env",
    ".ssh",
    ".aws",
    "credentials",
    "secrets",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "kubeconfig",
    ".gnupg",
];

const DANGEROUS_CMD_PATTERNS: &[&str] = &[
    "rm -rf",
    "curl -fsSL",
    "wget -O- ",
    "| sh",
    "| bash",
    "sudo ",
    "chmod 777",
    "dd if=",
    "mkfs",
    "kill -9",
    ":(){:",
    "> /dev/sda",
    "shutdown",
    "> ~/.zshrc",
    "> ~/.bashrc",
];

pub fn score(kind: &EventKind) -> Vec<String> {
    match kind {
        EventKind::ToolUse { name, raw_input, .. } => score_tool(name, raw_input),
        _ => Vec::new(),
    }
}

/// Risk-score a tool call by *category*, not an exact name list — robust across
/// the Claude vocabulary (Read/Edit/Write/Bash/WebFetch…) and Cursor's
/// (`run_terminal_command_v2`, `edit_file_v2`, `search_replace`, …, with varied
/// arg keys). New or renamed variants keep getting scored.
pub fn score_tool(name: &str, args: &Value) -> Vec<String> {
    let mut tags = Vec::new();
    let n = name.to_ascii_lowercase();
    if n == "bash" || n.contains("terminal") {
        // shell: inspect the command string
        if let Some(cmd) = string_field(args, "command") {
            let lc = cmd.to_lowercase();
            if DANGEROUS_CMD_PATTERNS.iter().any(|p| lc.contains(p)) {
                tags.push("shell-dangerous".into());
            }
            if lc.contains("curl ") || lc.contains("wget ") {
                tags.push("network".into());
            }
            if SECRET_HINTS.iter().any(|h| lc.contains(h)) {
                tags.push("secret-path".into());
            }
        }
    } else if n.contains("web_search") || n.contains("web_fetch") || n == "webfetch"
        || n == "websearch"
    {
        tags.push("network".into());
    } else if is_file_tool(&n) {
        if let Some(p) = tool_file_path(args) {
            if hits_secret(&p) {
                tags.push("secret-path".into());
            }
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

/// Tools that read or write a file path (Claude + Cursor, incl. `_v2`).
fn is_file_tool(n: &str) -> bool {
    n == "read"
        || n.contains("edit") // Edit, NotebookEdit, edit_file[_v2], MultiEdit
        || n.contains("write") // Write, write, write_file
        || n.contains("file") // read_file[_v2], delete_file, create_file
        || n == "search_replace"
        || n == "apply_patch"
        || n == "reapply"
}

/// A tool's target file path across the varied arg keys these agents use.
fn tool_file_path(args: &Value) -> Option<String> {
    ["file_path", "target_file", "path", "relativeWorkspacePath"]
        .iter()
        .find_map(|k| string_field(args, k))
}

pub fn level(tags: &[String]) -> RiskLevel {
    if tags.iter().any(|t| t == "shell-dangerous" || t == "secret-path") {
        RiskLevel::High
    } else if tags.iter().any(|t| t == "network") {
        RiskLevel::Med
    } else {
        RiskLevel::Low
    }
}

#[derive(Debug, Clone, Copy)]
pub enum RiskLevel {
    Low,
    Med,
    High,
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(|s| s.to_string())
}

fn hits_secret(s: &str) -> bool {
    let lc = s.to_lowercase();
    SECRET_HINTS.iter().any(|h| lc.contains(h))
}
