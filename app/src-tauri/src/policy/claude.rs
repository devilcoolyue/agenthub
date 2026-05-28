use super::scan::{scan_claude_permission, scan_command_for_secrets, short, short_value};
use super::{AgentPolicy, PolicyItem, RemoveAction};
use anyhow::Result;
use serde_json::Value;
use std::fs;
use std::path::Path;

pub(super) fn read_claude(home: &Path) -> Result<AgentPolicy> {
    let settings = home.join(".claude").join("settings.json");
    let local = home.join(".claude").join("settings.local.json");
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
    let hooks_path = home.join(".claude").join("hooks.json");
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
