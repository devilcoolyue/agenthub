use super::{PolicyItem, RemoveAction};
use std::path::Path;

/// Classify a Claude permission rule string. Returns a single PolicyItem.
pub(super) fn scan_claude_permission(rule: &str, file: &Path) -> PolicyItem {
    let mut tags = Vec::new();
    // Secret-y substrings (heuristic, conservative)
    let lc = rule.to_lowercase();
    if lc.contains("sshpass") || lc.contains("password=") || lc.contains("token=") {
        tags.push("secret-in-rule".into());
    }
    // Inline -p '<pwd>' style passwords
    if rule.contains("-p '") || rule.contains("-p \"") {
        tags.push("secret-in-rule".into());
    }
    // Long base64-looking bearer tokens
    if rule.contains("sk-") || rule.contains("Bearer ") {
        tags.push("secret-in-rule".into());
    }
    // Wildcard scope
    if rule.ends_with(":*)") || rule.ends_with(":*") {
        tags.push("wildcard-permission".into());
    }
    // Bare `WebSearch` / `WebFetch` etc. with no parens = unrestricted scope
    if !rule.contains('(') && !rule.is_empty() && rule.chars().next().map(|c| c.is_alphabetic()).unwrap_or(false) {
        tags.push("unrestricted-tool".into());
    }
    tags.sort();
    tags.dedup();
    PolicyItem {
        category: "permission".into(),
        label: rule.to_string(),
        detail: None,
        risk_tags: tags,
        source_path: file.display().to_string(),
        remove_action: Some(RemoveAction::ClaudePermissionAllow {
            rule: rule.to_string(),
            file: file.display().to_string(),
        }),
    }
}

pub(super) fn scan_command_for_secrets(cmd: &str) -> Vec<String> {
    let lc = cmd.to_lowercase();
    let mut tags = Vec::new();
    if lc.contains("sshpass")
        || lc.contains("password=")
        || lc.contains("token=")
        || cmd.contains("-p '")
        || cmd.contains("-p \"")
        || cmd.contains("sk-")
        || cmd.contains("Bearer ")
    {
        tags.push("secret-in-rule".into());
    }
    tags
}

pub(super) fn short_value(v: &serde_json::Value, n: usize) -> String {
    let s = v.to_string();
    if s.chars().count() <= n {
        s
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

pub(super) fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}
