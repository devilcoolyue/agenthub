use crate::event::{Agent, AgentEvent, EventKind};
use crate::risk::{level, RiskLevel};
use owo_colors::OwoColorize;

pub fn print_event(ev: &AgentEvent) {
    let ts = ev.timestamp.with_timezone(&chrono::Local).format("%H:%M:%S");
    let agent_cell = match ev.agent {
        Agent::ClaudeCode => format!("{:<11}", ev.agent.label()).cyan().to_string(),
        Agent::Codex => format!("{:<11}", ev.agent.label()).magenta().to_string(),
    };
    let (kind_cell, detail) = render_kind(&ev.kind);
    let risk_cell = render_risk(&ev.risk_tags);
    let cwd_cell = ev
        .cwd
        .as_deref()
        .map(short_cwd)
        .unwrap_or_else(|| "-".into());

    println!(
        "{ts}  {agent}  {kind:<10}  {detail:<48}  {cwd:<26}  {risk}",
        ts = ts.to_string().dimmed(),
        agent = agent_cell,
        kind = kind_cell,
        detail = truncate(&detail, 48),
        cwd = truncate(&cwd_cell, 26).dimmed(),
        risk = risk_cell
    );
}

fn render_kind(k: &EventKind) -> (String, String) {
    match k {
        EventKind::SessionStart { model, version } => (
            "session".bold().to_string(),
            format!(
                "start  model={} v={}",
                model.as_deref().unwrap_or("?"),
                version.as_deref().unwrap_or("?")
            ),
        ),
        EventKind::UserPrompt { text } => ("user".green().to_string(), one_line(text)),
        EventKind::AssistantThinking => ("think".dimmed().to_string(), "(thinking...)".into()),
        EventKind::AssistantText { text } => ("reply".to_string(), one_line(text)),
        EventKind::ToolUse { name, summary, .. } => {
            (name.yellow().to_string(), summary.clone())
        }
        EventKind::ToolResult { ok, summary } => {
            let kind = if *ok {
                "ok".green().to_string()
            } else {
                "err".red().to_string()
            };
            (kind, one_line(summary))
        }
        EventKind::System { text } => ("system".dimmed().to_string(), one_line(text)),
        EventKind::Other { tag } => (tag.dimmed().to_string(), String::new()),
    }
}

fn render_risk(tags: &[String]) -> String {
    if tags.is_empty() {
        return "·".dimmed().to_string();
    }
    let lvl = level(tags);
    let dot = match lvl {
        RiskLevel::Low => "●".green().to_string(),
        RiskLevel::Med => "●".yellow().to_string(),
        RiskLevel::High => "●".red().to_string(),
    };
    format!("{}  [{}]", dot, tags.join(","))
}

fn short_cwd(p: &str) -> String {
    if let Some(home) = dirs::home_dir() {
        if let Some(rel) = p.strip_prefix(home.to_string_lossy().as_ref()) {
            return format!("~{rel}");
        }
    }
    p.to_string()
}

fn one_line(s: &str) -> String {
    s.replace('\n', " ⏎ ").trim().to_string()
}

fn truncate(s: &str, n: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() <= n {
        s.to_string()
    } else {
        let mut out: String = chars.into_iter().take(n.saturating_sub(1)).collect();
        out.push('…');
        out
    }
}
