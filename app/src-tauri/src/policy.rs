use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// A single policy line item we can display + (optionally) act on.
#[derive(Debug, Clone, Serialize)]
pub struct PolicyItem {
    pub category: String,   // "permission" | "trusted-project" | "model-provider" | "mcp-server" | "hook" | "info"
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

/* ---------- top-level reader ---------- */

pub fn read_all() -> Vec<AgentPolicy> {
    let home = match dirs::home_dir() {
        Some(h) => h,
        None => return vec![],
    };
    let mut out = Vec::new();
    if let Ok(p) = read_claude(&home) {
        out.push(p);
    }
    if let Ok(p) = read_codex(&home) {
        out.push(p);
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

/* ---------- Claude reader ---------- */

fn read_claude(home: &Path) -> Result<AgentPolicy> {
    let settings = home.join(".claude/settings.json");
    let local = home.join(".claude/settings.local.json");
    let mut items = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut model: Option<String> = None;

    if let Ok(s) = fs::read_to_string(&settings) {
        files.push(settings.display().to_string());
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(m) = v.get("model").and_then(|x| x.as_str()) {
                model = Some(m.into());
            }
            // Surface a couple of notable settings inline.
            if v.get("autoCompactEnabled") == Some(&Value::Bool(false)) {
                items.push(PolicyItem {
                    category: "info".into(),
                    label: "autoCompactEnabled = false".into(),
                    detail: Some("compaction disabled; very long sessions may overflow context".into()),
                    risk_tags: vec![],
                    source_path: settings.display().to_string(),
                    remove_action: None,
                });
            }
        }
    }

    if let Ok(s) = fs::read_to_string(&local) {
        files.push(local.display().to_string());
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            // permissions.allow[] is the headline policy surface
            if let Some(arr) = v
                .get("permissions")
                .and_then(|x| x.get("allow"))
                .and_then(|x| x.as_array())
            {
                for rule in arr {
                    if let Some(s) = rule.as_str() {
                        items.push(scan_claude_permission(s, &local));
                    }
                }
            }
            // MCP — currently null for this user, but support listing.
            if let Some(mcp) = v.get("mcpServers").and_then(|x| x.as_object()) {
                for (name, def) in mcp {
                    items.push(PolicyItem {
                        category: "mcp-server".into(),
                        label: format!("MCP: {name}"),
                        detail: Some(short_value(def, 120)),
                        risk_tags: vec!["mcp-active".into()],
                        source_path: local.display().to_string(),
                        remove_action: None, // safe-write coming later
                    });
                }
            }
        }
    }

    // hooks.json — separate file
    let hooks_path = home.join(".claude/hooks.json");
    if let Ok(s) = fs::read_to_string(&hooks_path) {
        files.push(hooks_path.display().to_string());
        if let Ok(v) = serde_json::from_str::<Value>(&s) {
            if let Some(events) = v.get("hooks").and_then(|x| x.as_object()) {
                for (event_name, groups) in events {
                    if let Some(arr) = groups.as_array() {
                        for (gi, group) in arr.iter().enumerate() {
                            let matcher = group
                                .get("matcher")
                                .and_then(|x| x.as_str())
                                .unwrap_or("");
                            if let Some(hooks) =
                                group.get("hooks").and_then(|x| x.as_array())
                            {
                                for (hi, hook) in hooks.iter().enumerate() {
                                    let cmd = hook
                                        .get("command")
                                        .and_then(|x| x.as_str())
                                        .unwrap_or("");
                                    let mut tags = scan_command_for_secrets(cmd);
                                    tags.push("external-script-hook".into());
                                    tags.sort();
                                    tags.dedup();
                                    items.push(PolicyItem {
                                        category: "hook".into(),
                                        label: format!("{event_name}/{matcher}"),
                                        detail: Some(short(cmd, 200)),
                                        risk_tags: tags,
                                        source_path: hooks_path.display().to_string(),
                                        remove_action: Some(RemoveAction::ClaudeHook {
                                            event: event_name.clone(),
                                            group_index: gi,
                                            hook_index: hi,
                                            file: hooks_path.display().to_string(),
                                        }),
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    Ok(AgentPolicy {
        agent: "claude-code".into(),
        model,
        config_files: files,
        items,
        high_risk_count: 0,
    })
}

/// Classify a Claude permission rule string. Returns a single PolicyItem.
fn scan_claude_permission(rule: &str, file: &Path) -> PolicyItem {
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

fn short_value(v: &Value, n: usize) -> String {
    let s = v.to_string();
    if s.chars().count() <= n {
        s
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn short(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn scan_command_for_secrets(cmd: &str) -> Vec<String> {
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

/* ---------- Codex reader ---------- */

fn read_codex(home: &Path) -> Result<AgentPolicy> {
    let cfg = home.join(".codex/config.toml");
    let mut items = Vec::new();
    let mut files = Vec::new();
    let mut model: Option<String> = None;

    if let Ok(s) = fs::read_to_string(&cfg) {
        files.push(cfg.display().to_string());
        let doc: toml_edit::DocumentMut = s
            .parse()
            .with_context(|| format!("parse {}", cfg.display()))?;

        // active profile model
        if let Some(active) = doc.get("profile").and_then(|x| x.as_str()) {
            if let Some(profiles) = doc.get("profiles").and_then(|x| x.as_table()) {
                if let Some(prof) = profiles.get(active).and_then(|x| x.as_table()) {
                    if let Some(m) = prof.get("model").and_then(|x| x.as_str()) {
                        model = Some(m.into());
                    }
                }
            }
        }

        // model_providers.*
        if let Some(providers) = doc.get("model_providers").and_then(|x| x.as_table()) {
            for (name, def) in providers.iter() {
                let mut tags = Vec::new();
                let mut detail_parts: Vec<String> = Vec::new();
                let base_url = def
                    .as_table()
                    .and_then(|t| t.get("base_url"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                if !base_url.is_empty() {
                    if !base_url.contains("openai.com") {
                        tags.push("third-party-proxy".into());
                    }
                    detail_parts.push(format!("base_url = {}", base_url));
                }
                // peek at http_headers for tokens (do not log the value)
                if let Some(headers) = def
                    .as_table()
                    .and_then(|t| t.get("http_headers"))
                    .and_then(|x| x.as_table())
                {
                    for (k, v) in headers.iter() {
                        let val = v.as_str().unwrap_or("");
                        let looks_secret = k.eq_ignore_ascii_case("authorization")
                            || k.to_lowercase().contains("token")
                            || k.to_lowercase().contains("key")
                            || val.starts_with("sk-")
                            || val.starts_with("Bearer ");
                        if looks_secret && !val.is_empty() {
                            tags.push("plaintext-token".into());
                            detail_parts.push(format!("{} = <hidden>", k));
                        }
                    }
                }
                tags.sort();
                tags.dedup();
                items.push(PolicyItem {
                    category: "model-provider".into(),
                    label: format!("provider: {}", name),
                    detail: Some(detail_parts.join(" · ")),
                    risk_tags: tags,
                    source_path: cfg.display().to_string(),
                    remove_action: Some(RemoveAction::CodexModelProvider {
                        name: name.to_string(),
                    }),
                });
            }
        }

        // projects.* trust_level
        if let Some(projects) = doc.get("projects").and_then(|x| x.as_table()) {
            for (path, def) in projects.iter() {
                let trust = def
                    .as_table()
                    .and_then(|t| t.get("trust_level"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("");
                let mut tags = Vec::new();
                if trust == "trusted" {
                    tags.push("trusted-project".into());
                }
                items.push(PolicyItem {
                    category: "trusted-project".into(),
                    label: path.to_string(),
                    detail: Some(format!("trust_level = {}", trust)),
                    risk_tags: tags,
                    source_path: cfg.display().to_string(),
                    remove_action: Some(RemoveAction::CodexTrustedProject {
                        path: path.to_string(),
                    }),
                });
            }
        }

        // mcp_servers.* (if present)
        if let Some(mcps) = doc.get("mcp_servers").and_then(|x| x.as_table()) {
            for (name, _) in mcps.iter() {
                items.push(PolicyItem {
                    category: "mcp-server".into(),
                    label: format!("MCP: {}", name),
                    detail: None,
                    risk_tags: vec!["mcp-active".into()],
                    source_path: cfg.display().to_string(),
                    remove_action: None,
                });
            }
        }
    }

    Ok(AgentPolicy {
        agent: "codex".into(),
        model,
        config_files: files,
        items,
        high_risk_count: 0,
    })
}

/* ---------- safe writer ---------- */

pub fn apply_remove(action: &RemoveAction) -> Result<()> {
    apply_remove_batch(std::slice::from_ref(action)).map(|_| ())
}

/// Apply a batch of removals; one atomic write per affected file.
/// Returns counts. Failures are collected per action (best-effort).
pub fn apply_remove_batch(actions: &[RemoveAction]) -> Result<BatchResult> {
    use std::collections::HashMap;
    // Group actions by target file path.
    let mut by_file: HashMap<PathBuf, Vec<&RemoveAction>> = HashMap::new();
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home"))?;
    let codex_cfg = home.join(".codex/config.toml");

    for a in actions {
        let p: PathBuf = match a {
            RemoveAction::ClaudePermissionAllow { file, .. } => PathBuf::from(file),
            RemoveAction::ClaudeHook { file, .. } => PathBuf::from(file),
            RemoveAction::CodexTrustedProject { .. } => codex_cfg.clone(),
            RemoveAction::CodexModelProvider { .. } => codex_cfg.clone(),
        };
        by_file.entry(p).or_default().push(a);
    }

    let mut removed = 0usize;
    let mut failed: Vec<String> = Vec::new();

    for (path, group) in by_file {
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        if ext == "json" {
            // Read once, mutate JSON in place, write once.
            match batch_apply_json(&path, &group) {
                Ok(n) => removed += n,
                Err(e) => failed.push(format!("{}: {}", path.display(), e)),
            }
        } else if ext == "toml" {
            match batch_apply_toml(&path, &group) {
                Ok(n) => removed += n,
                Err(e) => failed.push(format!("{}: {}", path.display(), e)),
            }
        } else {
            failed.push(format!("{}: unsupported file extension", path.display()));
        }
    }

    Ok(BatchResult { removed, failed })
}

fn batch_apply_json(path: &Path, group: &[&RemoveAction]) -> Result<usize> {
    let original = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut v: Value = serde_json::from_str(&original)
        .with_context(|| format!("parse {}", path.display()))?;
    let mut n = 0usize;

    // 1) ClaudePermissionAllow: bulk-retain in one pass
    let perm_rules: Vec<&str> = group
        .iter()
        .filter_map(|a| match a {
            RemoveAction::ClaudePermissionAllow { rule, .. } => Some(rule.as_str()),
            _ => None,
        })
        .collect();
    if !perm_rules.is_empty() {
        if let Some(arr) = v
            .get_mut("permissions")
            .and_then(|p| p.get_mut("allow"))
            .and_then(|x| x.as_array_mut())
        {
            let before = arr.len();
            arr.retain(|x| !x.as_str().is_some_and(|s| perm_rules.contains(&s)));
            n += before - arr.len();
        }
    }

    // 2) ClaudeHook: index-based deletion. Sort descending by (event, group, hook)
    //    so earlier indices stay valid as we delete.
    let mut hook_actions: Vec<(&String, usize, usize)> = group
        .iter()
        .filter_map(|a| match a {
            RemoveAction::ClaudeHook {
                event,
                group_index,
                hook_index,
                ..
            } => Some((event, *group_index, *hook_index)),
            _ => None,
        })
        .collect();
    hook_actions.sort_by(|a, b| b.cmp(a)); // descending
    for (event_name, gi, hi) in hook_actions {
        let arr = v
            .get_mut("hooks")
            .and_then(|h| h.get_mut(event_name.as_str()))
            .and_then(|x| x.as_array_mut());
        if let Some(arr) = arr {
            if let Some(group_obj) = arr.get_mut(gi) {
                let hooks_arr = group_obj
                    .get_mut("hooks")
                    .and_then(|x| x.as_array_mut());
                if let Some(hooks_arr) = hooks_arr {
                    if hi < hooks_arr.len() {
                        hooks_arr.remove(hi);
                        n += 1;
                        // if the group's hooks array is now empty, drop the whole group
                        if hooks_arr.is_empty() {
                            arr.remove(gi);
                        }
                    }
                }
            }
        }
    }

    if n == 0 {
        return Err(anyhow!("no matching entries found"));
    }
    let serialized = serde_json::to_string_pretty(&v)? + "\n";
    atomic_write_with_backup(path, &serialized)?;
    Ok(n)
}

fn batch_apply_toml(path: &Path, group: &[&RemoveAction]) -> Result<usize> {
    let original = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut doc: toml_edit::DocumentMut = original
        .parse()
        .with_context(|| format!("parse {}", path.display()))?;
    let mut n = 0usize;

    for a in group {
        let (parent, key) = match a {
            RemoveAction::CodexTrustedProject { path } => ("projects", path.as_str()),
            RemoveAction::CodexModelProvider { name } => ("model_providers", name.as_str()),
            _ => continue,
        };
        if let Some(parent_tbl) = doc.get_mut(parent).and_then(|x| x.as_table_mut()) {
            if parent_tbl.remove(key).is_some() {
                n += 1;
                if parent_tbl.is_empty() {
                    doc.remove(parent);
                }
            }
        }
    }
    if n == 0 {
        return Err(anyhow!("no matching entries found"));
    }
    atomic_write_with_backup(path, &doc.to_string())?;
    Ok(n)
}

/* ---------- backup management ---------- */

/// List recent .agenthub.bak.* files in known config directories.
pub fn list_recent_backups(limit: usize) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = Vec::new();
    let Some(home) = dirs::home_dir() else { return out };
    let dirs_to_scan = [home.join(".claude"), home.join(".codex")];
    for d in &dirs_to_scan {
        if let Ok(entries) = fs::read_dir(d) {
            for ent in entries.flatten() {
                let name = match ent.file_name().into_string() {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let Some(idx) = name.find(".agenthub.bak.") else {
                    continue;
                };
                let original_name = &name[..idx];
                let ts = name[idx + ".agenthub.bak.".len()..].to_string();
                let backup_path = ent.path();
                let original_path = d.join(original_name);
                let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(BackupInfo {
                    backup_path: backup_path.display().to_string(),
                    original_path: original_path.display().to_string(),
                    timestamp: parse_compact_ts(&ts),
                    size_bytes: size,
                });
            }
        }
    }
    // Newest first
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    out.truncate(limit);
    out
}

fn parse_compact_ts(ts: &str) -> String {
    // input: YYYYMMDDTHHMMSS  → output: YYYY-MM-DDTHH:MM:SSZ
    if ts.len() >= 15 {
        format!(
            "{}-{}-{}T{}:{}:{}Z",
            &ts[0..4], &ts[4..6], &ts[6..8],
            &ts[9..11], &ts[11..13], &ts[13..15]
        )
    } else {
        ts.to_string()
    }
}

/// Restore from a .bak: snapshot current state first, then copy backup → original.
pub fn restore_backup(backup_path: &str, original_path: &str) -> Result<()> {
    let bak = Path::new(backup_path);
    let orig = Path::new(original_path);
    if !bak.exists() {
        return Err(anyhow!("backup file not found"));
    }
    let content = fs::read_to_string(bak)
        .with_context(|| format!("read backup {}", bak.display()))?;
    // atomic_write_with_backup creates a .bak of the CURRENT state automatically.
    atomic_write_with_backup(orig, &content)?;
    Ok(())
}

/// Write atomically: copy current → `.bak.<ts>`, write `path.tmp`, fsync, rename → path.
/// Survives crashes mid-write; original always recoverable from the latest .bak.
fn atomic_write_with_backup(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
        let bak = backup_path(path, &ts);
        fs::copy(path, &bak).with_context(|| format!("backup {}", bak.display()))?;
    }
    let tmp = path.with_extension({
        let mut e = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        e.push_str(".agenthub-tmp");
        e
    });
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .with_context(|| format!("open tmp {}", tmp.display()))?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("rename {} → {}", tmp.display(), path.display()))?;
    Ok(())
}

fn backup_path(path: &Path, ts: &str) -> PathBuf {
    let mut s = path.to_string_lossy().to_string();
    s.push_str(".agenthub.bak.");
    s.push_str(ts);
    PathBuf::from(s)
}
