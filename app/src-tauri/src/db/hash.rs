use crate::agent::{Agent, AgentEvent, EventKind};
use sha2::{Digest, Sha256};

/// Stable per-event fingerprint for idempotent backfill / dedup.
/// First 16 bytes of sha256 over a normalized representation. ~3.4×10^38 keyspace,
/// collision in practice negligible for our scale.
pub fn event_hash(ev: &AgentEvent) -> String {
    let mut h = Sha256::new();
    let agent = match ev.agent {
        Agent::ClaudeCode => "claude-code",
        Agent::Codex => "codex",
        Agent::Cursor => "cursor",
    };
    h.update(agent.as_bytes());
    h.update(b"|");
    h.update(ev.session_id.as_bytes());
    h.update(b"|");
    h.update(ev.timestamp.to_rfc3339().as_bytes());
    h.update(b"|");
    match &ev.kind {
        EventKind::SessionStart { model, version } => {
            h.update(b"session_start|");
            h.update(model.as_deref().unwrap_or("").as_bytes());
            h.update(b"|");
            h.update(version.as_deref().unwrap_or("").as_bytes());
        }
        EventKind::UserPrompt { text } => {
            h.update(b"user_prompt|");
            h.update(text.as_bytes());
        }
        EventKind::AssistantThinking => h.update(b"assistant_thinking"),
        EventKind::AssistantText { text } => {
            h.update(b"assistant_text|");
            h.update(text.as_bytes());
        }
        EventKind::ToolUse { name, summary, .. } => {
            h.update(b"tool_use|");
            h.update(name.as_bytes());
            h.update(b"|");
            h.update(summary.as_bytes());
        }
        EventKind::ToolResult { ok, summary } => {
            h.update(if *ok { b"tool_result_ok|".as_slice() } else { b"tool_result_err|".as_slice() });
            h.update(summary.as_bytes());
        }
        EventKind::System { text } => {
            h.update(b"system|");
            h.update(text.as_bytes());
        }
        EventKind::Usage => {
            h.update(b"usage|");
            if let Some(u) = &ev.usage {
                h.update(
                    format!(
                        "{}|{}|{}|{}",
                        u.input_tokens, u.cache_read_tokens, u.output_tokens, u.reasoning_tokens
                    )
                    .as_bytes(),
                );
            }
        }
        EventKind::Other { tag } => {
            h.update(b"other|");
            h.update(tag.as_bytes());
        }
    }
    let bytes = h.finalize();
    let mut out = String::with_capacity(32);
    for b in &bytes[..16] {
        out.push_str(&format!("{:02x}", b));
    }
    out
}
