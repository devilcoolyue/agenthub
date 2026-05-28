use super::event::{Agent, AgentEvent, EventKind};
use super::risk;
use super::usage::Usage;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::path::Path;

#[derive(Default)]
pub struct CodexState {
    pub cwd: Option<String>,
    pub model: Option<String>,
}

/// Read the configured default model from `~/.codex/config.toml`.
///
/// Codex session logs only carry the model on `turn_context`, which can arrive
/// after the first `token_count` (usage) line — leaving early rows with no
/// model. The config's default fills that gap. Returns `None` when the config
/// doesn't pin a model; we deliberately don't guess codex's built-in default,
/// since stamping a wrong model is worse than leaving it unknown.
pub fn config_default_model(home: &Path) -> Option<String> {
    let cfg = home.join(".codex/config.toml");
    let s = std::fs::read_to_string(cfg).ok()?;
    default_model_from_toml(&s)
}

fn default_model_from_toml(s: &str) -> Option<String> {
    let doc: toml_edit::DocumentMut = s.parse().ok()?;
    // An active `profile` selects `[profiles.<name>].model`; it overrides the
    // top-level `model` key.
    if let Some(active) = doc.get("profile").and_then(|x| x.as_str()) {
        if let Some(m) = doc
            .get("profiles")
            .and_then(|x| x.as_table())
            .and_then(|t| t.get(active))
            .and_then(|x| x.as_table())
            .and_then(|t| t.get("model"))
            .and_then(|x| x.as_str())
        {
            return Some(m.to_string());
        }
    }
    doc.get("model").and_then(|x| x.as_str()).map(String::from)
}

pub fn parse_line(line: &str, session_id: &str, st: &mut CodexState) -> Result<Option<AgentEvent>> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(line)?;
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let payload = v.get("payload");
    let ts = v
        .get("timestamp")
        .and_then(|x| x.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    // state updates that don't emit events
    if ty == "session_meta" {
        if let Some(p) = payload {
            st.cwd = p.get("cwd").and_then(|x| x.as_str()).map(String::from);
            // session_meta.model is often null. Only override when it actually
            // carries one, so we don't clobber the config-default seed (or a
            // model already learned from turn_context) with None.
            if let Some(m) = p.get("model").and_then(|x| x.as_str()) {
                st.model = Some(m.into());
            }
        }
        return Ok(Some(make(
            session_id,
            st,
            ts,
            EventKind::SessionStart {
                model: st.model.clone(),
                version: payload
                    .and_then(|p| p.get("cli_version"))
                    .and_then(|x| x.as_str())
                    .map(String::from),
            },
        )));
    }
    if ty == "turn_context" {
        if let Some(p) = payload {
            if let Some(c) = p.get("cwd").and_then(|x| x.as_str()) {
                st.cwd = Some(c.into());
            }
            // turn_context is the authoritative source for the active model
            // (e.g. "gpt-5.2", "gpt-5.5", "gpt-5.3-codex"). session_meta usually
            // omits it. Model can change mid-session, so update on every turn.
            if let Some(m) = p.get("model").and_then(|x| x.as_str()) {
                st.model = Some(m.into());
            }
        }
        return Ok(None);
    }

    let sub = payload
        .and_then(|p| p.get("type"))
        .and_then(|x| x.as_str())
        .unwrap_or("");

    let kind = match (ty, sub) {
        ("event_msg", "user_message") => {
            let text = payload
                .and_then(|p| p.get("message"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(EventKind::UserPrompt { text })
            }
        }
        ("event_msg", "agent_message") => {
            let text = payload
                .and_then(|p| p.get("message"))
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            if text.is_empty() {
                None
            } else {
                Some(EventKind::AssistantText { text })
            }
        }
        ("response_item", "function_call") => {
            let p = payload.unwrap();
            let name = p
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("?")
                .to_string();
            let args_raw = p.get("arguments").and_then(|x| x.as_str()).unwrap_or("{}");
            let parsed_args: Value =
                serde_json::from_str(args_raw).unwrap_or_else(|_| Value::String(args_raw.into()));
            let summary = summarize_codex_tool(&name, &parsed_args);
            Some(EventKind::ToolUse {
                name: friendly_tool_name(&name),
                summary,
                raw_input: parsed_args,
            })
        }
        ("response_item", "function_call_output") => {
            let p = payload.unwrap();
            let raw = p
                .get("output")
                .map(|x| x.to_string())
                .unwrap_or_default();
            // exec output starts with "Process exited with code N"
            let ok = !raw.contains("code 1\n")
                && !raw.contains("code 2\n")
                && !raw.contains("error");
            let summary = first_chars(&raw.trim_matches('"').replace("\\n", " ⏎ "), 120);
            Some(EventKind::ToolResult { ok, summary })
        }
        ("event_msg", "patch_apply_end") => Some(EventKind::ToolResult {
            ok: true,
            summary: "patch applied".into(),
        }),
        ("event_msg", "task_started") => Some(EventKind::System {
            text: "task_started".into(),
        }),
        ("event_msg", "task_complete") => Some(EventKind::System {
            text: "task_complete".into(),
        }),
        ("event_msg", "error") => {
            let m = payload
                .and_then(|p| p.get("message"))
                .and_then(|x| x.as_str())
                .unwrap_or("error");
            Some(EventKind::System { text: m.into() })
        }
        ("response_item", "reasoning") => Some(EventKind::AssistantThinking),
        ("event_msg", "token_count") => {
            // Emit a Usage event using the per-turn delta (last_token_usage).
            // total_token_usage is cumulative and would double-count.
            let p = payload.unwrap();
            let info = p.get("info");
            let last = info.and_then(|i| i.get("last_token_usage"));
            if let Some(last) = last {
                let n = |k: &str| last.get(k).and_then(|x| x.as_u64()).unwrap_or(0);
                let input = n("input_tokens");
                let cached = n("cached_input_tokens");
                let output = n("output_tokens");
                let reasoning = n("reasoning_output_tokens");
                if input + output + reasoning == 0 {
                    None
                } else {
                    // codex input_tokens already includes cached
                    let non_cached = input.saturating_sub(cached);
                    let usage = Usage {
                        // No fallback: if turn_context hasn't told us the
                        // model yet, leave it None rather than lying with
                        // "gpt-5". The pricing layer handles unknowns.
                        model: st.model.clone(),
                        input_tokens: non_cached,
                        cache_creation_tokens: 0,
                        cache_read_tokens: cached,
                        output_tokens: output,
                        reasoning_tokens: reasoning,
                        cost_micros: 0,
                    }
                    .finalize();
                    // attach to a Usage-kind event and return early via a custom path
                    return Ok(Some(AgentEvent {
                        agent: Agent::Codex,
                        session_id: session_id.to_string(),
                        cwd: st.cwd.clone(),
                        timestamp: ts,
                        kind: EventKind::Usage,
                        risk_tags: Vec::new(),
                        usage: Some(usage),
                    }));
                }
            } else {
                None
            }
        }
        ("event_msg", "exec_command_end") => None,
        ("response_item", "message") => None, // duplicate of agent_message stream
        _ => None,
    };

    let Some(kind) = kind else { return Ok(None) };
    Ok(Some(make(session_id, st, ts, kind)))
}

fn make(
    session_id: &str,
    st: &CodexState,
    ts: DateTime<Utc>,
    kind: EventKind,
) -> AgentEvent {
    let tags = risk::score(&kind);
    AgentEvent {
        agent: Agent::Codex,
        session_id: session_id.to_string(),
        cwd: st.cwd.clone(),
        timestamp: ts,
        kind,
        risk_tags: tags,
        usage: None,
    }
}

fn friendly_tool_name(raw: &str) -> String {
    match raw {
        "exec_command" => "Bash".into(),
        "apply_patch" => "Edit".into(),
        "write_stdin" => "Stdin".into(),
        other => other.to_string(),
    }
}

fn summarize_codex_tool(name: &str, args: &Value) -> String {
    let s = |k: &str| args.get(k).and_then(|x| x.as_str()).unwrap_or("");
    match name {
        "exec_command" => first_chars(s("cmd"), 80),
        "apply_patch" => {
            let p = s("input");
            // extract first changed file path
            for line in p.lines().take(5) {
                if let Some(rest) = line.strip_prefix("*** Update File: ") {
                    return rest.to_string();
                }
                if let Some(rest) = line.strip_prefix("*** Add File: ") {
                    return format!("(new) {rest}");
                }
            }
            first_chars(p, 60)
        }
        _ => {
            if let Some(obj) = args.as_object() {
                if let Some((k, v)) = obj.iter().next() {
                    return format!("{k}={}", first_chars(&v.to_string(), 60));
                }
            }
            String::new()
        }
    }
}

fn first_chars(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        chars.into_iter().take(n).collect::<String>() + "…"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_model_reads_top_level_key() {
        let toml = r#"
            model = "gpt-5.5"
            [model_providers.proxy]
            base_url = "http://example/v1"
        "#;
        assert_eq!(default_model_from_toml(toml).as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn default_model_prefers_active_profile() {
        let toml = r#"
            model = "gpt-5.5"
            profile = "work"
            [profiles.work]
            model = "gpt-5.3-codex"
        "#;
        assert_eq!(
            default_model_from_toml(toml).as_deref(),
            Some("gpt-5.3-codex")
        );
    }

    #[test]
    fn default_model_falls_back_when_profile_has_no_model() {
        let toml = r#"
            model = "gpt-5.5"
            profile = "work"
            [profiles.work]
            approval_policy = "never"
        "#;
        assert_eq!(default_model_from_toml(toml).as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn default_model_is_none_when_unset() {
        // Mirrors a config that pins providers/projects but no model — codex
        // then uses its own built-in default, which we can't know.
        let toml = r#"
            [model_providers.proxy]
            base_url = "http://example/v1"
            [projects."/tmp/x"]
            trust_level = "trusted"
        "#;
        assert_eq!(default_model_from_toml(toml), None);
    }

    #[test]
    fn session_meta_keeps_seeded_default_when_model_null() {
        let mut st = CodexState {
            cwd: None,
            model: Some("gpt-5.5".into()),
        };
        let line = r#"{"type":"session_meta","timestamp":"2026-05-28T00:00:00Z","payload":{"cwd":"/tmp","model":null}}"#;
        parse_line(line, "sid", &mut st).unwrap();
        assert_eq!(st.model.as_deref(), Some("gpt-5.5"));
    }

    #[test]
    fn turn_context_overrides_seeded_default() {
        let mut st = CodexState {
            cwd: None,
            model: Some("gpt-5.5".into()),
        };
        let line = r#"{"type":"turn_context","timestamp":"2026-05-28T00:00:00Z","payload":{"model":"gpt-5.3-codex"}}"#;
        parse_line(line, "sid", &mut st).unwrap();
        assert_eq!(st.model.as_deref(), Some("gpt-5.3-codex"));
    }
}
