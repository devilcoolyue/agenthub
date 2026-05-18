use super::event::{Agent, AgentEvent, EventKind};
use super::risk;
use super::usage::Usage;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Default)]
pub struct CodexState {
    pub cwd: Option<String>,
    pub model: Option<String>,
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
            // session_meta.model is often null; fall back to gpt-5 default.
            // (We avoid model_provider since "openai" isn't a useful model name.)
            st.model = p
                .get("model")
                .and_then(|x| x.as_str())
                .map(String::from);
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
                        model: st.model.clone().or_else(|| Some("gpt-5".into())),
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
