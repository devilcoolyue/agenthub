use crate::event::{Agent, AgentEvent, EventKind};
use crate::risk;
use anyhow::Result;
use chrono::{DateTime, Utc};
use serde_json::Value;

pub fn parse_line(line: &str) -> Result<Option<AgentEvent>> {
    if line.trim().is_empty() {
        return Ok(None);
    }
    let v: Value = serde_json::from_str(line)?;
    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
    let session_id = v
        .get("sessionId")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .to_string();
    let cwd = v.get("cwd").and_then(|x| x.as_str()).map(String::from);
    let ts = v
        .get("timestamp")
        .and_then(|x| x.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
        .unwrap_or_else(Utc::now);

    let kind = match ty {
        "user" => classify_user(&v),
        "assistant" => classify_assistant(&v),
        "system" => Some(EventKind::System {
            text: v
                .get("content")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string(),
        }),
        // first event for a session has version + cwd context
        "bridge-session" => None, // noisy, skip
        "last-prompt" | "permission-mode" | "file-history-snapshot" | "attachment"
        | "ai-title" => None,
        other => Some(EventKind::Other {
            tag: other.to_string(),
        }),
    };

    let Some(kind) = kind else { return Ok(None) };
    let tags = risk::score(&kind);
    Ok(Some(AgentEvent {
        agent: Agent::ClaudeCode,
        session_id,
        cwd,
        timestamp: ts,
        kind,
        risk_tags: tags,
    }))
}

fn classify_user(v: &Value) -> Option<EventKind> {
    let msg = v.get("message")?;
    let content = msg.get("content")?;
    // user prompt: content is a plain string
    if let Some(s) = content.as_str() {
        if s.is_empty() {
            return None;
        }
        return Some(EventKind::UserPrompt { text: s.into() });
    }
    // tool_result is wrapped in user message as array
    if let Some(arr) = content.as_array() {
        for part in arr {
            if part.get("type").and_then(|t| t.as_str()) == Some("tool_result") {
                let is_error = part
                    .get("is_error")
                    .and_then(|x| x.as_bool())
                    .unwrap_or(false);
                let summary = extract_tool_result_preview(part.get("content"));
                return Some(EventKind::ToolResult {
                    ok: !is_error,
                    summary,
                });
            }
        }
    }
    None
}

fn classify_assistant(v: &Value) -> Option<EventKind> {
    let arr = v.get("message")?.get("content")?.as_array()?;
    for part in arr {
        let t = part.get("type").and_then(|x| x.as_str()).unwrap_or("");
        match t {
            "tool_use" => {
                let name = part
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("?")
                    .to_string();
                let input = part.get("input").cloned().unwrap_or(Value::Null);
                let summary = summarize_tool(&name, &input);
                return Some(EventKind::ToolUse {
                    name,
                    summary,
                    raw_input: input,
                });
            }
            "thinking" => return Some(EventKind::AssistantThinking),
            "text" => {
                if let Some(s) = part.get("text").and_then(|x| x.as_str()) {
                    if !s.trim().is_empty() {
                        return Some(EventKind::AssistantText { text: s.into() });
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_tool_result_preview(c: Option<&Value>) -> String {
    let Some(c) = c else { return String::new() };
    if let Some(s) = c.as_str() {
        return first_chars(s, 120);
    }
    if let Some(arr) = c.as_array() {
        for part in arr {
            if let Some(s) = part.get("text").and_then(|x| x.as_str()) {
                return first_chars(s, 120);
            }
        }
    }
    String::new()
}

fn summarize_tool(name: &str, input: &Value) -> String {
    let s = |k: &str| input.get(k).and_then(|x| x.as_str()).unwrap_or("");
    match name {
        "Read" | "Edit" | "Write" | "NotebookEdit" => s("file_path").to_string(),
        "Bash" => first_chars(s("command"), 80),
        "Grep" => format!("{} in {}", s("pattern"), s("path")),
        "Glob" => s("pattern").to_string(),
        "WebFetch" | "WebSearch" => s("url").to_string() + s("query"),
        "Agent" => format!("subagent: {}", s("description")),
        "Skill" => format!("/{}", s("skill")),
        _ => {
            // fallback: dump first key=val
            if let Some(obj) = input.as_object() {
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
