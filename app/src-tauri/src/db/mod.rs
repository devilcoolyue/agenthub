mod cost;
mod events;
mod fts;
mod hash;
mod kv;
mod schema;
mod sessions;

pub use cost::{DailyCost, ModelCost, ModelUsage};
pub use sessions::{SessionCategory, SessionSummary, SessionsFilter};

use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct Db {
    // pub(super) so sibling files in `db/` can take the connection lock.
    pub(super) conn: Mutex<Connection>,
}

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path).with_context(|| format!("open db {}", path.display()))?;
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
        conn.execute_batch(schema::SCHEMA)?;
        schema::migrate(&conn);
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}
