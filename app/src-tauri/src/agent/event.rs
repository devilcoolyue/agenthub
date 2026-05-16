use super::usage::Usage;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
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
    Usage,
    Other {
        tag: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentEvent {
    pub agent: Agent,
    pub session_id: String,
    pub cwd: Option<String>,
    pub timestamp: DateTime<Utc>,
    pub kind: EventKind,
    pub risk_tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
}
