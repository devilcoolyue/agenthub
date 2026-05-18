use super::{AgentPolicy, PolicyItem, RemoveAction};
use anyhow::{Context, Result};
use std::fs;
use std::path::Path;

pub(super) fn read_codex(home: &Path) -> Result<AgentPolicy> {
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
