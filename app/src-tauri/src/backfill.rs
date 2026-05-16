use crate::agent::{Source, Tailer};
use crate::db::Db;
use anyhow::{anyhow, Result};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "phase", rename_all = "snake_case")]
pub enum BackfillProgress {
    Started,
    HashesMigrated { migrated: usize },
    Scanning { scanned: usize, inserted: usize },
    Done { scanned: usize, inserted: usize, hashes_migrated: usize },
    Failed { error: String },
}

pub fn run(db: &Db, mut on_progress: impl FnMut(BackfillProgress)) -> Result<()> {
    on_progress(BackfillProgress::Started);

    // 1) Hash any pre-existing rows so the unique-index dedupe is effective.
    let migrated = db.backfill_hashes().unwrap_or(0);
    on_progress(BackfillProgress::HashesMigrated { migrated });

    // 2) Walk every JSONL we know about from the very beginning.
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no HOME"))?;
    let claude_root = home.join(".claude/projects");
    let codex_root = home.join(".codex/sessions");

    let mut tailer = Tailer::new(false, None); // start_from_end=false, no age limit
    tailer.scan_dir(&claude_root, Source::ClaudeCode);
    tailer.scan_dir(&codex_root, Source::Codex);

    let mut scanned = 0usize;
    let mut inserted = 0usize;
    // wrap on_progress so we can call from inside the closure
    let mut last_emit_at = 0usize;
    tailer.poll(|ev| {
        scanned += 1;
        if let Ok(true) = db.insert(&ev) {
            inserted += 1;
        }
        if scanned - last_emit_at >= 500 {
            last_emit_at = scanned;
            on_progress(BackfillProgress::Scanning { scanned, inserted });
        }
    })?;

    on_progress(BackfillProgress::Done {
        scanned,
        inserted,
        hashes_migrated: migrated,
    });
    Ok(())
}
