use super::event::EventKind;
use serde_json::Value;

const SECRET_HINTS: &[&str] = &[
    ".env",
    ".ssh",
    ".aws",
    "credentials",
    "secrets",
    "id_rsa",
    "id_ed25519",
    ".npmrc",
    ".pypirc",
    ".netrc",
    "kubeconfig",
    ".gnupg",
];

const DANGEROUS_CMD_PATTERNS: &[&str] = &[
    "rm -rf",
    "curl -fsSL",
    "wget -O- ",
    "| sh",
    "| bash",
    "sudo ",
    "chmod 777",
    "dd if=",
    "mkfs",
    "kill -9",
    ":(){:",
    "> /dev/sda",
    "shutdown",
    "> ~/.zshrc",
    "> ~/.bashrc",
];

pub fn score(kind: &EventKind) -> Vec<String> {
    let mut tags = Vec::new();
    if let EventKind::ToolUse {
        name, raw_input, ..
    } = kind
    {
        match name.as_str() {
            "Read" | "Edit" | "Write" | "NotebookEdit" => {
                if let Some(p) = string_field(raw_input, "file_path") {
                    if hits_secret(&p) {
                        tags.push("secret-path".into());
                    }
                }
            }
            "Bash" => {
                if let Some(cmd) = string_field(raw_input, "command") {
                    let lc = cmd.to_lowercase();
                    for pat in DANGEROUS_CMD_PATTERNS {
                        if lc.contains(pat) {
                            tags.push("shell-dangerous".into());
                            break;
                        }
                    }
                    if lc.contains("curl ") || lc.contains("wget ") {
                        tags.push("network".into());
                    }
                    for hint in SECRET_HINTS {
                        if lc.contains(hint) {
                            tags.push("secret-path".into());
                            break;
                        }
                    }
                }
            }
            "WebFetch" | "WebSearch" => tags.push("network".into()),
            _ => {}
        }
    }
    tags.sort();
    tags.dedup();
    tags
}

pub fn level(tags: &[String]) -> RiskLevel {
    if tags.iter().any(|t| t == "shell-dangerous" || t == "secret-path") {
        RiskLevel::High
    } else if tags.iter().any(|t| t == "network") {
        RiskLevel::Med
    } else {
        RiskLevel::Low
    }
}

#[derive(Debug, Clone, Copy)]
pub enum RiskLevel {
    Low,
    Med,
    High,
}

fn string_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)?.as_str().map(|s| s.to_string())
}

fn hits_secret(s: &str) -> bool {
    let lc = s.to_lowercase();
    SECRET_HINTS.iter().any(|h| lc.contains(h))
}
