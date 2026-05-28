mod backup;
mod claude;
mod codex;
mod cursor;
mod mutate;
mod scan;

pub use backup::{list_recent_backups, restore_backup};
pub use mutate::{apply_remove, apply_remove_batch};

use serde::{Deserialize, Serialize};

/// A single policy line item we can display + (optionally) act on.
#[derive(Debug, Clone, Serialize)]
pub struct PolicyItem {
    pub category: String,   // "permission" | "trusted-project" | "model-provider" | "mcp-server" | "rule" | "hook" | "info"
    pub label: String,
    pub detail: Option<String>,
    pub risk_tags: Vec<String>, // e.g. "secret-in-rule","wildcard-permission","plaintext-token","third-party-proxy"
    pub source_path: String,
    pub remove_action: Option<RemoveAction>,
}

/// What the "Remove" button posts back. The dispatcher in mutate() pattern-matches on this.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum RemoveAction {
    /// Remove a single rule from settings.local.json's permissions.allow[]
    ClaudePermissionAllow { rule: String, file: String },
    /// Drop a [projects."<path>"] table from codex config.toml
    CodexTrustedProject { path: String },
    /// Drop a [model_providers.<name>] table from codex config.toml
    CodexModelProvider { name: String },
    /// Remove a hook entry from ~/.claude/hooks.json by its address
    ClaudeHook {
        event: String,         // e.g. "PreToolUse"
        group_index: usize,    // index in event array
        hook_index: usize,     // index in group.hooks[]
        file: String,
    },
}

#[derive(Debug, Clone, Serialize)]
pub struct BackupInfo {
    pub backup_path: String,
    pub original_path: String,
    pub timestamp: String, // ISO-8601
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchResult {
    pub removed: usize,
    pub failed: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct AgentPolicy {
    pub agent: String, // "claude-code" | "codex"
    pub model: Option<String>,
    pub config_files: Vec<String>,
    pub items: Vec<PolicyItem>,
    pub high_risk_count: usize,
}

/// Read configs from ~/.claude, ~/.codex, and Cursor, classify their entries,
/// and return one AgentPolicy per agent that actually has files on disk.
pub fn read_all() -> Vec<AgentPolicy> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let mut out = Vec::new();
    if let Ok(p) = claude::read_claude(&home) {
        out.push(p);
    }
    if let Ok(p) = codex::read_codex(&home) {
        out.push(p);
    }
    // Cursor is read-only (configuration-only); only include it when it
    // actually has config files on disk.
    if let Ok(p) = cursor::read_cursor(&home) {
        if !p.config_files.is_empty() {
            out.push(p);
        }
    }
    for ap in &mut out {
        ap.high_risk_count = ap
            .items
            .iter()
            .filter(|i| !i.risk_tags.is_empty())
            .count();
    }
    out
}
