mod claude;
mod codex;
mod event;
mod render;
mod risk;
mod tail;

use anyhow::Result;
use std::thread::sleep;
use std::time::Duration;
use tail::{Source, Tailer};

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let from_start = args.iter().any(|a| a == "--from-start");
    let max_age_secs: Option<u64> = if from_start {
        None
    } else {
        // by default only watch files modified in the last 24h, to avoid mass-scanning old sessions
        Some(60 * 60 * 24)
    };

    let mut tailer = Tailer::new(!from_start, max_age_secs);

    let home = dirs::home_dir().expect("home dir");
    let claude_root = home.join(".claude").join("projects");
    let codex_root = home.join(".codex").join("sessions");

    print_header(
        &claude_root.display().to_string(),
        &codex_root.display().to_string(),
        from_start,
    );

    // initial scan
    tailer.scan_dir(&claude_root, Source::ClaudeCode);
    tailer.scan_dir(&codex_root, Source::Codex);

    loop {
        tailer.scan_dir(&claude_root, Source::ClaudeCode);
        tailer.scan_dir(&codex_root, Source::Codex);
        tailer.poll(|ev| render::print_event(&ev))?;
        sleep(Duration::from_millis(500));
    }
}

fn print_header(claude: &str, codex: &str, from_start: bool) {
    use owo_colors::OwoColorize;
    eprintln!("{}  watching:", "agenthub-tail".bold().cyan());
    eprintln!("  claude-code  {}", claude.dimmed());
    eprintln!("  codex        {}", codex.dimmed());
    eprintln!(
        "  mode         {}",
        if from_start {
            "from-start (replay everything)"
        } else {
            "tail (new activity only, last 24h files)"
        }
        .dimmed()
    );
    eprintln!();
}
