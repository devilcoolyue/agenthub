use super::Db;
use rusqlite::params;

impl Db {
    pub fn kv_get(&self, key: &str) -> Option<String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(
            "SELECT value FROM app_kv WHERE key = ?",
            params![key],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    }

    pub fn kv_set(&self, key: &str, value: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute(
            "INSERT OR REPLACE INTO app_kv (key, value) VALUES (?, ?)",
            params![key, value],
        );
    }

    pub fn kv_delete(&self, key: &str) {
        let conn = self.conn.lock().unwrap();
        let _ = conn.execute("DELETE FROM app_kv WHERE key = ?", params![key]);
    }
}
