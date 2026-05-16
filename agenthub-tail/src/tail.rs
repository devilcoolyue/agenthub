use crate::codex::CodexState;
use crate::event::AgentEvent;
use crate::{claude, codex};
use anyhow::Result;
use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;
use walkdir::WalkDir;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    ClaudeCode,
    Codex,
}

pub struct FileState {
    pub source: Source,
    pub offset: u64,
    pub partial: String,
    pub session_id: String,
    pub codex: CodexState,
}

pub struct Tailer {
    files: HashMap<PathBuf, FileState>,
    pub start_from_end: bool,
    pub max_age_secs: Option<u64>,
}

impl Tailer {
    pub fn new(start_from_end: bool, max_age_secs: Option<u64>) -> Self {
        Self {
            files: HashMap::new(),
            start_from_end,
            max_age_secs,
        }
    }

    pub fn scan_dir(&mut self, root: &Path, source: Source) {
        if !root.exists() {
            return;
        }
        for entry in WalkDir::new(root).into_iter().filter_map(|e| e.ok()) {
            if !entry.file_type().is_file() {
                continue;
            }
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            if self.files.contains_key(p) {
                continue;
            }
            if let Some(max) = self.max_age_secs {
                if let Ok(meta) = entry.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if let Ok(age) = SystemTime::now().duration_since(modified) {
                            if age.as_secs() > max {
                                continue;
                            }
                        }
                    }
                }
            }
            let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
            let start = if self.start_from_end { size } else { 0 };
            let session_id = extract_session_id(p, source);
            self.files.insert(
                p.to_path_buf(),
                FileState {
                    source,
                    offset: start,
                    partial: String::new(),
                    session_id,
                    codex: CodexState::default(),
                },
            );
        }
    }

    pub fn poll(&mut self, mut emit: impl FnMut(AgentEvent)) -> Result<()> {
        let paths: Vec<PathBuf> = self.files.keys().cloned().collect();
        for path in paths {
            let st = self.files.get_mut(&path).unwrap();
            let size = match std::fs::metadata(&path) {
                Ok(m) => m.len(),
                Err(_) => continue,
            };
            if size < st.offset {
                // file was rotated/truncated
                st.offset = 0;
                st.partial.clear();
            }
            if size == st.offset {
                continue;
            }
            let mut f = match File::open(&path) {
                Ok(f) => f,
                Err(_) => continue,
            };
            if f.seek(SeekFrom::Start(st.offset)).is_err() {
                continue;
            }
            let mut buf = String::new();
            if f.read_to_string(&mut buf).is_err() {
                continue;
            }
            st.offset = size;
            let combined = std::mem::take(&mut st.partial) + &buf;
            let mut iter = combined.split_inclusive('\n').peekable();
            while let Some(piece) = iter.next() {
                if piece.ends_with('\n') {
                    let line = piece.trim_end_matches('\n');
                    let parsed = match st.source {
                        Source::ClaudeCode => claude::parse_line(line),
                        Source::Codex => codex::parse_line(line, &st.session_id, &mut st.codex),
                    };
                    match parsed {
                        Ok(Some(ev)) => emit(ev),
                        Ok(None) => {}
                        Err(_) => {} // skip malformed
                    }
                } else {
                    // incomplete trailing line
                    st.partial = piece.to_string();
                }
            }
        }
        Ok(())
    }
}

fn extract_session_id(p: &Path, source: Source) -> String {
    let stem = p
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    match source {
        Source::ClaudeCode => stem,
        Source::Codex => {
            // rollout-<ts>-<uuid>  → keep uuid (last 5 dash-separated segments form the uuid)
            let parts: Vec<&str> = stem.split('-').collect();
            if parts.len() >= 5 {
                parts[parts.len() - 5..].join("-")
            } else {
                stem
            }
        }
    }
}
