use super::scan::short;
use super::{AgentPolicy, PolicyItem};
use anyhow::Result;
use serde_json::Value;
use std::fs;
use std::path::Path;

/// Cursor is a *configuration-only* surface: it has no JSONL audit log, so we
/// never produce Activity events for it. Here we statically read the global
/// Cursor config — MCP servers, rules, and notable editor settings — and list
/// them. Every item is read-only (`remove_action: None`); AgentHub does not
/// mutate Cursor's files.
pub(super) fn read_cursor(home: &Path) -> Result<AgentPolicy> {
    let mut items = Vec::new();
    let mut files: Vec<String> = Vec::new();

    read_mcp(home, &mut items, &mut files);
    read_rules(home, &mut items, &mut files);
    read_settings(home, &mut items, &mut files);

    Ok(AgentPolicy {
        agent: "cursor".into(),
        model: None,
        config_files: files,
        items,
        high_risk_count: 0,
    })
}

/// `~/.cursor/mcp.json` — global MCP servers. Shape:
/// `{ "mcpServers": { "<name>": { "command"|"url", "args", "env" } } }`.
fn read_mcp(home: &Path, items: &mut Vec<PolicyItem>, files: &mut Vec<String>) {
    let path = home.join(".cursor").join("mcp.json");
    let Ok(s) = fs::read_to_string(&path) else {
        return;
    };
    files.push(path.display().to_string());
    let Some(v) = parse_jsonc(&s) else { return };
    let Some(servers) = v.get("mcpServers").and_then(|x| x.as_object()) else {
        return;
    };
    for (name, def) in servers {
        let mut tags = vec!["mcp-active".to_string()];
        let detail = if let Some(url) = def.get("url").and_then(|x| x.as_str()) {
            format!("url = {url}")
        } else {
            let cmd = def.get("command").and_then(|x| x.as_str()).unwrap_or("");
            let args = def
                .get("args")
                .and_then(|x| x.as_array())
                .map(|a| {
                    a.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_default();
            short(&format!("{cmd} {args}").trim().to_string(), 120)
        };
        if mcp_carries_secret(def) {
            tags.push("plaintext-token".to_string());
        }
        items.push(PolicyItem {
            category: "mcp-server".into(),
            label: format!("MCP: {name}"),
            detail: Some(detail),
            risk_tags: tags,
            source_path: path.display().to_string(),
            remove_action: None,
        });
    }
}

/// True if any `env` value or header on an MCP definition looks like a
/// plaintext credential.
fn mcp_carries_secret(def: &Value) -> bool {
    let scan = |obj: Option<&serde_json::Map<String, Value>>| {
        obj.map(|m| {
            m.iter().any(|(k, v)| {
                let val = v.as_str().unwrap_or("");
                let kl = k.to_lowercase();
                kl.contains("token")
                    || kl.contains("key")
                    || kl.contains("secret")
                    || kl.contains("password")
                    || kl == "authorization"
                    || val.starts_with("sk-")
                    || val.starts_with("Bearer ")
            })
        })
        .unwrap_or(false)
    };
    scan(def.get("env").and_then(|x| x.as_object()))
        || scan(def.get("headers").and_then(|x| x.as_object()))
}

/// Cursor rules: modern `~/.cursor/rules/*.mdc` (+ `.md`) and the legacy
/// single-file `~/.cursorrules`. Project-scoped rules and the GUI "User Rules"
/// (stored in Cursor's SQLite state) are out of scope for this global view.
fn read_rules(home: &Path, items: &mut Vec<PolicyItem>, files: &mut Vec<String>) {
    let dir = home.join(".cursor").join("rules");
    if let Ok(entries) = fs::read_dir(&dir) {
        let mut names: Vec<String> = entries
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .filter_map(|e| {
                let p = e.path();
                let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("");
                if ext == "mdc" || ext == "md" {
                    p.file_name().and_then(|x| x.to_str()).map(String::from)
                } else {
                    None
                }
            })
            .collect();
        if !names.is_empty() {
            files.push(dir.display().to_string());
            names.sort();
            for name in names {
                items.push(PolicyItem {
                    category: "rule".into(),
                    label: format!("rule: {name}"),
                    detail: None,
                    risk_tags: vec![],
                    source_path: dir.display().to_string(),
                    remove_action: None,
                });
            }
        }
    }

    let legacy = home.join(".cursorrules");
    if let Ok(s) = fs::read_to_string(&legacy) {
        files.push(legacy.display().to_string());
        let first = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
        items.push(PolicyItem {
            category: "rule".into(),
            label: "rule: .cursorrules (legacy)".into(),
            detail: Some(short(first.trim(), 120)),
            risk_tags: vec![],
            source_path: legacy.display().to_string(),
            remove_action: None,
        });
    }
}

/// Cursor's VS Code-style `settings.json` (JSONC), under
/// `~/Library/Application Support/Cursor/User/` on macOS and
/// `%APPDATA%\Cursor\User\` on Windows. Surface a proxy (if configured) and a
/// summary of Cursor-specific keys; we deliberately don't dump every editor
/// preference.
fn read_settings(home: &Path, items: &mut Vec<PolicyItem>, files: &mut Vec<String>) {
    #[cfg(target_os = "macos")]
    let path = home
        .join("Library")
        .join("Application Support")
        .join("Cursor")
        .join("User")
        .join("settings.json");
    #[cfg(target_os = "windows")]
    let path = home
        .join("AppData")
        .join("Roaming")
        .join("Cursor")
        .join("User")
        .join("settings.json");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let path = home
        .join(".config")
        .join("Cursor")
        .join("User")
        .join("settings.json");
    let Ok(s) = fs::read_to_string(&path) else {
        return;
    };
    files.push(path.display().to_string());
    let Some(v) = parse_jsonc(&s) else { return };
    let Some(obj) = v.as_object() else { return };

    for key in ["http.proxy", "https.proxy"] {
        if let Some(proxy) = obj.get(key).and_then(|x| x.as_str()) {
            if proxy.is_empty() {
                continue;
            }
            let local = proxy.contains("127.0.0.1") || proxy.contains("localhost");
            items.push(PolicyItem {
                category: "info".into(),
                label: format!("{key} = {proxy}"),
                detail: Some(if local {
                    "local proxy".into()
                } else {
                    "traffic routed through an external proxy".into()
                }),
                risk_tags: if local {
                    vec![]
                } else {
                    vec!["third-party-proxy".into()]
                },
                source_path: path.display().to_string(),
                remove_action: None,
            });
        }
    }

    let cursor_keys: Vec<&str> = obj
        .keys()
        .filter(|k| k.starts_with("cursor.") || k.starts_with("cursor-"))
        .map(|k| k.as_str())
        .collect();
    items.push(PolicyItem {
        category: "info".into(),
        label: format!("settings.json ({} keys)", obj.len()),
        detail: if cursor_keys.is_empty() {
            None
        } else {
            Some(short(&format!("cursor: {}", cursor_keys.join(", ")), 200))
        },
        risk_tags: vec![],
        source_path: path.display().to_string(),
        remove_action: None,
    });
}

/// Parse JSON-with-comments (and tolerate trailing commas), as VS Code-family
/// `settings.json` and some `mcp.json` files use. Returns None on failure.
fn parse_jsonc(s: &str) -> Option<Value> {
    let cleaned = strip_trailing_commas(&strip_comments(s));
    serde_json::from_str(&cleaned).ok()
}

fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    chars.next();
                    while let Some(&n) = chars.peek() {
                        if n == '\n' {
                            break;
                        }
                        chars.next();
                    }
                }
                Some('*') => {
                    chars.next();
                    let mut prev = '\0';
                    for n in chars.by_ref() {
                        if prev == '*' && n == '/' {
                            break;
                        }
                        prev = n;
                    }
                }
                _ => out.push(c),
            },
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(s: &str) -> String {
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }
        if c == '"' {
            in_string = true;
            out.push(c);
            i += 1;
            continue;
        }
        if c == ',' {
            let mut j = i + 1;
            while j < chars.len() && chars[j].is_whitespace() {
                j += 1;
            }
            if j < chars.len() && (chars[j] == '}' || chars[j] == ']') {
                i += 1; // drop the trailing comma
                continue;
            }
        }
        out.push(c);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jsonc_strips_line_and_block_comments() {
        let s = r#"{
            // a line comment
            "a": 1, /* inline */ "b": "x // not a comment",
            /* block
               spanning */
            "c": true
        }"#;
        let v = parse_jsonc(s).unwrap();
        assert_eq!(v["a"], 1);
        assert_eq!(v["b"], "x // not a comment");
        assert_eq!(v["c"], true);
    }

    #[test]
    fn jsonc_tolerates_trailing_commas() {
        let s = r#"{ "a": [1, 2, 3,], "b": { "x": 1, }, }"#;
        let v = parse_jsonc(s).unwrap();
        assert_eq!(v["a"][2], 3);
        assert_eq!(v["b"]["x"], 1);
    }

    #[test]
    fn mcp_secret_detection() {
        let with_token: Value = serde_json::from_str(
            r#"{"command":"x","env":{"API_TOKEN":"abc"}}"#,
        )
        .unwrap();
        let plain: Value =
            serde_json::from_str(r#"{"command":"x","env":{"DEBUG":"1"}}"#).unwrap();
        assert!(mcp_carries_secret(&with_token));
        assert!(!mcp_carries_secret(&plain));
    }
}
