use super::BackupInfo;
use anyhow::{anyhow, Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

/// List recent .agenthub.bak.* files in known config directories.
pub fn list_recent_backups(limit: usize) -> Vec<BackupInfo> {
    let mut out: Vec<BackupInfo> = Vec::new();
    let Some(home) = dirs::home_dir() else { return out };
    let dirs_to_scan = [home.join(".claude"), home.join(".codex")];
    for d in &dirs_to_scan {
        if let Ok(entries) = fs::read_dir(d) {
            for ent in entries.flatten() {
                let name = match ent.file_name().into_string() {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                let Some(idx) = name.find(".agenthub.bak.") else {
                    continue;
                };
                let original_name = &name[..idx];
                let ts = name[idx + ".agenthub.bak.".len()..].to_string();
                let backup_path = ent.path();
                let original_path = d.join(original_name);
                let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
                out.push(BackupInfo {
                    backup_path: backup_path.display().to_string(),
                    original_path: original_path.display().to_string(),
                    timestamp: parse_compact_ts(&ts),
                    size_bytes: size,
                });
            }
        }
    }
    // Newest first
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    out.truncate(limit);
    out
}

fn parse_compact_ts(ts: &str) -> String {
    // input: YYYYMMDDTHHMMSS  → output: YYYY-MM-DDTHH:MM:SSZ
    if ts.len() >= 15 {
        format!(
            "{}-{}-{}T{}:{}:{}Z",
            &ts[0..4], &ts[4..6], &ts[6..8],
            &ts[9..11], &ts[11..13], &ts[13..15]
        )
    } else {
        ts.to_string()
    }
}

/// Restore from a .bak: snapshot current state first, then copy backup → original.
pub fn restore_backup(backup_path: &str, original_path: &str) -> Result<()> {
    let bak = Path::new(backup_path);
    let orig = Path::new(original_path);
    if !bak.exists() {
        return Err(anyhow!("backup file not found"));
    }
    let content = fs::read_to_string(bak)
        .with_context(|| format!("read backup {}", bak.display()))?;
    // atomic_write_with_backup creates a .bak of the CURRENT state automatically.
    atomic_write_with_backup(orig, &content)?;
    Ok(())
}

/// Write atomically: copy current → `.bak.<ts>`, write `path.tmp`, fsync, rename → path.
/// Survives crashes mid-write; original always recoverable from the latest .bak.
pub(super) fn atomic_write_with_backup(path: &Path, contents: &str) -> Result<()> {
    if path.exists() {
        let ts = chrono::Utc::now().format("%Y%m%dT%H%M%S").to_string();
        let bak = backup_path(path, &ts);
        fs::copy(path, &bak).with_context(|| format!("backup {}", bak.display()))?;
    }
    let tmp = path.with_extension({
        let mut e = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        e.push_str(".agenthub-tmp");
        e
    });
    {
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)
            .with_context(|| format!("open tmp {}", tmp.display()))?;
        f.write_all(contents.as_bytes())?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).with_context(|| format!("rename {} → {}", tmp.display(), path.display()))?;
    Ok(())
}

fn backup_path(path: &Path, ts: &str) -> PathBuf {
    let mut s = path.to_string_lossy().to_string();
    s.push_str(".agenthub.bak.");
    s.push_str(ts);
    PathBuf::from(s)
}
