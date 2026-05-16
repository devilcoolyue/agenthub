use chrono::{DateTime, Utc};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Agent {
    ClaudeCode,
    Codex,
}

impl Agent {
    pub fn label(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude-code",
            Agent::Codex => "codex",
        }
    }
}

#[derive(Debug, Clone)]
pub enum EventKind {
    SessionStart {
        model: Option<String>,
        version: Option<String>,
    },
    UserPrompt {
        text: String,
    },
    AssistantThinking,
    AssistantText {
        text: String,
    },
    ToolUse {
        name: String,
        summary: String,
        raw_input: Value,
    },
    ToolResult {
        ok: bool,
        summary: String,
    },
    System {
        text: String,
    },
    Other {
        tag: String,
    },
}

#[derive(Debug, Clone)]
pub struct AgentEvent {
    pub agent: Agent,
    pub session_id: String,
    pub cwd: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub kind: EventKind,
    pub risk_tags: Vec<String>,
}
