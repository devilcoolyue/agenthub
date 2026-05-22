use super::{BatchResult, RemoveAction};
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

pub fn apply_remove(action: &RemoveAction) -> Result<()> {
    apply_remove_batch(std::slice::from_ref(action)).map(|_| ())
}

/// Apply a batch of removals; one atomic write per affected file.
/// Returns counts. Failures are collected per action (best-effort).
pub fn apply_remove_batch(actions: &[RemoveAction]) -> Result<BatchResult> {
    use std::collections::HashMap;
    // Group actions by target file path.
    let mut by_file: HashMap<PathBuf, Vec<&RemoveAction>> = HashMap::new();
    let home = dirs::home_dir().ok_or_else(|| anyhow!("no home"))?;
    let codex_cfg = home.join(".codex").join("config.toml");

    for a in actions {
        let p: PathBuf = match a {
            RemoveAction::ClaudePermissionAllow { file, .. } => PathBuf::from(file),
            RemoveAction::ClaudeHook { file, .. } => PathBuf::from(file),
            RemoveAction::CodexTrustedProject { .. } => codex_cfg.clone(),
            RemoveAction::CodexModelProvider { .. } => codex_cfg.clone(),
        };
        by_file.entry(p).or_default().push(a);
    }

    let mut removed = 0usize;
    let mut failed: Vec<String> = Vec::new();

    for (path, group) in by_file {
        let ext = path
            .extension()
            .and_then(|x| x.to_str())
            .unwrap_or("")
            .to_string();
        if ext == "json" {
            // Read once, mutate JSON in place, write once.
            match batch_apply_json(&path, &group) {
                Ok(n) => removed += n,
                Err(e) => failed.push(format!("{}: {}", path.display(), e)),
            }
        } else if ext == "toml" {
            match batch_apply_toml(&path, &group) {
                Ok(n) => removed += n,
                Err(e) => failed.push(format!("{}: {}", path.display(), e)),
            }
        } else {
            failed.push(format!("{}: unsupported file extension", path.display()));
        }
    }

    Ok(BatchResult { removed, failed })
}

fn batch_apply_json(path: &Path, group: &[&RemoveAction]) -> Result<usize> {
    let original = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut v: Value = serde_json::from_str(&original)
        .with_context(|| format!("parse {}", path.display()))?;
    let mut n = 0usize;

    // 1) ClaudePermissionAllow: bulk-retain in one pass
    let perm_rules: Vec<&str> = group
        .iter()
        .filter_map(|a| match a {
            RemoveAction::ClaudePermissionAllow { rule, .. } => Some(rule.as_str()),
            _ => None,
        })
        .collect();
    if !perm_rules.is_empty() {
        if let Some(arr) = v
            .get_mut("permissions")
            .and_then(|p| p.get_mut("allow"))
            .and_then(|x| x.as_array_mut())
        {
            let before = arr.len();
            arr.retain(|x| !x.as_str().is_some_and(|s| perm_rules.contains(&s)));
            n += before - arr.len();
        }
    }

    // 2) ClaudeHook: index-based deletion. Sort descending by (event, group, hook)
    //    so earlier indices stay valid as we delete.
    let mut hook_actions: Vec<(&String, usize, usize)> = group
        .iter()
        .filter_map(|a| match a {
            RemoveAction::ClaudeHook {
                event,
                group_index,
                hook_index,
                ..
            } => Some((event, *group_index, *hook_index)),
            _ => None,
        })
        .collect();
    hook_actions.sort_by(|a, b| b.cmp(a)); // descending
    for (event_name, gi, hi) in hook_actions {
        let arr = v
            .get_mut("hooks")
            .and_then(|h| h.get_mut(event_name.as_str()))
            .and_then(|x| x.as_array_mut());
        if let Some(arr) = arr {
            if let Some(group_obj) = arr.get_mut(gi) {
                let hooks_arr = group_obj
                    .get_mut("hooks")
                    .and_then(|x| x.as_array_mut());
                if let Some(hooks_arr) = hooks_arr {
                    if hi < hooks_arr.len() {
                        hooks_arr.remove(hi);
                        n += 1;
                        // if the group's hooks array is now empty, drop the whole group
                        if hooks_arr.is_empty() {
                            arr.remove(gi);
                        }
                    }
                }
            }
        }
    }

    if n == 0 {
        return Err(anyhow!("no matching entries found"));
    }
    let serialized = serde_json::to_string_pretty(&v)? + "\n";
    super::backup::atomic_write_with_backup(path, &serialized)?;
    Ok(n)
}

fn batch_apply_toml(path: &Path, group: &[&RemoveAction]) -> Result<usize> {
    let original = fs::read_to_string(path)
        .with_context(|| format!("read {}", path.display()))?;
    let mut doc: toml_edit::DocumentMut = original
        .parse()
        .with_context(|| format!("parse {}", path.display()))?;
    let mut n = 0usize;

    for a in group {
        let (parent, key) = match a {
            RemoveAction::CodexTrustedProject { path } => ("projects", path.as_str()),
            RemoveAction::CodexModelProvider { name } => ("model_providers", name.as_str()),
            _ => continue,
        };
        if let Some(parent_tbl) = doc.get_mut(parent).and_then(|x| x.as_table_mut()) {
            if parent_tbl.remove(key).is_some() {
                n += 1;
                if parent_tbl.is_empty() {
                    doc.remove(parent);
                }
            }
        }
    }
    if n == 0 {
        return Err(anyhow!("no matching entries found"));
    }
    super::backup::atomic_write_with_backup(path, &doc.to_string())?;
    Ok(n)
}
