# Architecture

What's in the code today and why. Read this before making non-trivial changes.

---

## Data flow at a glance

```
   Claude Code              Codex
   ~/.claude/projects/      ~/.codex/sessions/YYYY/MM/DD/
   <encoded-cwd>/           rollout-<ts>-<uuid>.jsonl
   <session-uuid>.jsonl

         │ append-only writes by the agents themselves
         ▼
   ┌─────────────────┐
   │  tail.rs        │  polling, 500 ms tick, per-file offset
   │  (Rust thread)  │  → emits AgentEvent
   └────────┬────────┘
            │
            ▼
   ┌─────────────────┐
   │  parser dispatch│  claude.rs · codex.rs
   │                 │  → normalized AgentEvent
   └────────┬────────┘
            │
            ├──→ db.rs · INSERT OR IGNORE into events
            │           + upsert into sessions (materialized)
            │
            └──→ app.emit("agent-event", ev) → Tauri webview
                                                │
                                                ▼
                                       React listener
                                       updates the live
                                       activity stream
```

Source files never leave the agents' machines. We only read them.

---

## Module layout

```
agenthub/
├── AgentHub_PRD.md                 — original product framing
├── README.md
├── plan/
│   ├── ROADMAP.md                  — phased roadmap
│   ├── BACKLOG.md                  — granular task list
│   └── ARCHITECTURE.md             — this file
├── agenthub-tail/                  — original CLI prototype (kept for reference)
│   └── src/
│       ├── main.rs                 — terminal renderer
│       ├── event.rs · claude.rs · codex.rs · risk.rs · tail.rs
└── app/                            — the actual Tauri app
    ├── package.json
    ├── src/                        — React + TypeScript
    │   ├── App.tsx                 — single-file SPA; views chosen by a tab state
    │   ├── types.ts                — schema mirrors of the Rust types + helpers
    │   ├── App.css                 — single-file dark theme
    │   ├── main.tsx                — React 19 StrictMode mount
    │   └── assets/
    └── src-tauri/
        ├── Cargo.toml
        ├── tauri.conf.json
        └── src/
            ├── lib.rs              — Tauri builder, command handlers, tail thread spawner
            ├── db.rs               — SQLite (events + sessions tables, all aggregates)
            ├── backfill.rs         — full-history scan with progress events
            ├── policy.rs           — config readers + atomic safe writer
            └── agent/
                ├── mod.rs
                ├── event.rs        — AgentEvent + EventKind + Agent
                ├── claude.rs       — Claude Code JSONL parser
                ├── codex.rs        — Codex JSONL parser (per-file CodexState)
                ├── tail.rs         — polling tail + multi-source dispatcher
                ├── risk.rs         — risk-tag rules
                └── usage.rs        — Usage struct + per-model pricing table
```

---

## The normalized event

Every parser produces `AgentEvent`:

```rust
struct AgentEvent {
    agent: Agent,                  // ClaudeCode | Codex
    session_id: String,
    cwd: Option<String>,
    timestamp: DateTime<Utc>,
    kind: EventKind,               // enum: ToolUse / UserPrompt / ToolResult / ...
    risk_tags: Vec<String>,
    usage: Option<Usage>,          // attached if the event carried token counts
}
```

`EventKind` is a serde-tagged enum (`#[serde(tag = "type", rename_all = "snake_case")]`),
which round-trips cleanly to a TypeScript discriminated union.

All views (Activity stream, Session detail, Cost cards, …) consume this same
shape regardless of source. Adding a new agent = writing one new parser file +
emitting `AgentEvent`s.

---

## Storage: SQLite

Path: `~/Library/Application Support/com.agenthub.dev/events.db` (Tauri `app_data_dir`).

Two tables:

### `events`
Append-only event log. One row per event. The full `AgentEvent` is also
serialized into the `data` column for full-fidelity replay.

| column                  | purpose                                             |
|-------------------------|-----------------------------------------------------|
| `id`                    | autoinc PK                                          |
| `agent` (`claude-code`/`codex`) | indexable agent label                       |
| `session_id`            | groups rows of a single conversation                |
| `timestamp`             | RFC-3339 UTC string                                 |
| `risk_high`             | 0/1, denormalized for fast "any risk" filtering     |
| `data`                  | full AgentEvent JSON (single source of truth)       |
| `model`, `input_tokens`, `cache_*_tokens`, `output_tokens`, `cost_micros` | denormalized usage cols for fast aggregation |
| `event_hash`            | sha256(stable fields)[:16], partial UNIQUE index    |

Indexes: `id DESC`, `session_id`, `(agent, timestamp)`, partial unique on
`event_hash WHERE NOT NULL`, partial `(timestamp) WHERE cost_micros > 0`.

### `sessions` (materialized aggregate)
One row per session. Maintained incrementally:

- On first launch with empty `sessions` and non-empty `events`, the migration
  rebuilds the whole thing from `events` in one query (~50 ms for ~7k events).
- Every `db.insert()` does an UPSERT after the event INSERT.
- `list_session_categories()` and `list_sessions(filter,…)` query this table
  exclusively, never `events` — that's the difference between "instant" and
  "noticeable lag" once data grows.

| column            | how it changes                                     |
|-------------------|----------------------------------------------------|
| `session_id` PK   | new event with unseen session_id → INSERT          |
| `agent`           | first writer wins                                  |
| `cwd`             | `prefer non-null`: later non-null overwrites null  |
| `start_ts`/`end_ts` | monotonic widen                                  |
| `event_count`     | +1 per inserted event                              |
| `tool_count`      | +1 if kind is `tool_use`                           |
| `high_risk_count` | += event's `risk_high`                             |
| `cost_micros`     | += event's `cost_micros`                           |

### Why materialized vs JSON aggregation
Earlier versions did `GROUP BY session_id` + `json_extract(data, '$.cwd')`
on demand. With ~7000 events that's ~500 ms per query, enough to feel laggy
when switching to Sessions tab. The materialized table dropped that to 5 ms.

---

## Tail loop

`agent::tail::Tailer`:

- Owns a `HashMap<PathBuf, FileState>`.
- `FileState` has the current read offset and a partial-line buffer (in case
  poll lands mid-line).
- On each poll tick (500 ms):
  1. Walk the source roots to discover new JSONL files.
     - `max_age_secs` filter skips files older than 24 h on first scan, so
       app launch isn't an O(months) operation.
     - New files start at offset = current EOF (tail mode), unless
       `start_from_end = false` (used by `backfill::run`).
  2. For each tracked file, `stat()` to detect growth. If grown, seek to
     last offset, read to EOF, split lines, send each through the right
     parser.
- Why polling instead of `notify` (inotify/FSEvents): simpler, cross-
  platform, doesn't lose events under coalescing, costs basically nothing
  (one `stat` per file per 500 ms).

---

## Risk model

Rule-based, deliberately simple. See `agent/risk.rs` for live tags and
`policy.rs::scan_*` for config-time tags.

| Tag                    | Source                                              | Weight in Risk Score |
|------------------------|-----------------------------------------------------|----------------------|
| `shell-dangerous`      | `rm -rf`, `curl … \| sh`, `sudo`, `chmod 777`, …    | 10 pts each, cap 40  |
| `secret-path`          | `.env`, `.ssh`, `id_rsa`, `credentials`, …          | 8 pts each, cap 30   |
| `network`              | `curl`, `wget`, `WebFetch`, `WebSearch`             | 2 pts each, cap 20   |
| `secret-in-rule`       | `sshpass`, `sk-`, `Bearer`, inline passwords        | (policy view only)   |
| `wildcard-permission`  | rule ends with `:*` or `:*)`                        | (policy view only)   |
| `unrestricted-tool`    | bare tool name, no scope                            | (policy view only)   |
| `plaintext-token`      | http_headers with Authorization / Bearer            | (policy view only)   |
| `third-party-proxy`    | model_provider base_url not openai.com              | (policy view only)   |
| `trusted-project`      | codex `trust_level = "trusted"`                     | (policy view only)   |
| `external-script-hook` | any hook in `~/.claude/hooks.json`                  | (policy view only)   |

Risk Score = bounded weighted sum over the most recent 200 events (windowed,
so the score decays naturally when the agent goes idle). Bands: `< 20 LOW`,
`< 50 ELEVATED`, `≥ 50 HIGH`.

---

## Cost model

Token usage is per-event:

- **Claude Code** assistant messages carry a full `usage` block; we copy
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`,
  `output_tokens` directly.
- **Codex** emits a separate `token_count` event with `info.last_token_usage`
  (the *delta* for the most recent turn — using `total_token_usage` would
  double-count). Codex's `input_tokens` already *includes* `cached_input_tokens`,
  so we subtract before storing to align with Claude's accounting.

Pricing lives in `agent/usage.rs` as a model-family lookup table (`opus`,
`sonnet`, `haiku`, `gpt-5*`). Stored as `micros` per million tokens to avoid
float drift across millions of rows.

Cost stored as `i64 cost_micros` per event, summed by `daily_cost(days)` and
`model_cost(days)` queries.

---

## Policy reader + safe writer

`policy.rs` reads two file formats:

- **Claude (`~/.claude/settings.json`, `settings.local.json`, `hooks.json`)** —
  JSON via `serde_json::Value`. Writes use `to_string_pretty` and accept
  re-formatting (JSON has no canonical whitespace).
- **Codex (`~/.codex/config.toml`)** — `toml_edit::DocumentMut`. Edits are
  in-place so comments, whitespace, and table order are preserved.

Every write goes through `atomic_write_with_backup(path, contents)`:

1. If the target already exists, `fs::copy` it to
   `<path>.agenthub.bak.<YYYYMMDDTHHMMSS>` first.
2. Open `<path>.<ext>.agenthub-tmp`, write, `sync_all()` (fsync) so the
   bytes are on disk.
3. `fs::rename` the tmp to the target — atomic on macOS / Linux.

Crashes between step 1 and step 3 leave the original untouched; crashes after
step 3 leave the new content + a `.bak` of the previous content.

**Batch removes** group `RemoveAction`s by target file and apply all
mutations in one read → mutate → write cycle, producing exactly one `.bak`
per file regardless of how many items were touched.

**Restore** treats the user's `.bak` like any other source: read the backup,
write it back via the same atomic path. That itself creates a fresh `.bak`,
so a restore is also undoable.

---

## Backfill

`backfill::run(db, on_progress)`:

1. `db.backfill_hashes()` — populate `event_hash` for any legacy rows that
   pre-date the column (a one-time cost).
2. Construct a fresh `Tailer` with `start_from_end = false` and no age limit.
3. Walk every JSONL under `~/.claude/projects/` and `~/.codex/sessions/`
   from offset 0.
4. For each parsed `AgentEvent`, call `db.insert()`. Idempotency: insert
   uses `INSERT OR IGNORE` against the unique `event_hash` index, so already
   imported events are skipped silently.
5. Emit `BackfillProgress` every 500 events via the supplied callback,
   which `lib.rs::spawn_backfill_thread` forwards as a Tauri `backfill-progress`
   event.

Safe to run concurrently with the live tail: both call `db.insert()`, both
go through the same hash-based dedup.

---

## Frontend conventions

- One file `App.tsx`, one CSS file. No router (a `view` discriminated union
  state replaces it). Keeps the surface small while the product is still
  evolving.
- Each view is a child component; switching tabs unmounts the inactive one
  (cheap because state lives in DB / event listeners, not in the component
  tree).
- `useEffect` cleanups always set a `cancelled` flag before any `await` to
  avoid the React-19-StrictMode double-mount listener-leak class of bug.
  See `App.tsx` `agent-event` listener for the pattern.
- Long-running ops (backfill) push progress via Tauri events, not via
  `invoke` polling. UI subscribes once in `App` and lets banners react.

---

## Decisions worth knowing

| Decision                                | Why                                                                                        |
|-----------------------------------------|--------------------------------------------------------------------------------------------|
| Tauri 2 + Rust over Electron + Node     | Smaller binary, no Node runtime, type-safe SQL                                             |
| Polling tail (500 ms)                   | Simpler than `notify`; the work is `stat()` × few files, ~free                             |
| Materialized sessions table             | 100× speedup on Sessions / Categories vs on-demand `GROUP BY` + `json_extract`             |
| Cost as `i64 micros`                    | No float drift over millions of inserts                                                    |
| `sha256(...)[:16]` event hash           | Idempotent backfill without needing a stable provider-supplied ID                          |
| `toml_edit` for Codex config            | Preserves user's comments + formatting on round-trip                                       |
| `atomic_write + .bak.<ts>`              | User trust: every config edit reversible by `cp` of the latest backup                      |
| Polling SessionsView with offset+limit  | Avoids loading 345 cards at once; IntersectionObserver fires next page                     |
| Risk Score over last 200 events         | Decays naturally; doesn't accumulate to a permanent "scary" number after one bad command   |
| Single CSS file + dark only             | Keeps visual identity tight; users don't ask for theme settings until they ask             |
| One AgentEvent shape for all sources    | Adding a new agent = one parser file, not changes throughout the stack                     |

---

## Things that look weird but are intentional

- `policy.rs::atomic_write_with_backup` rewrites JSON files instead of
  preserving comments. We accept this because `settings.local.json` is
  rewritten by Claude Code on every config change anyway; preserving the
  original formatting wouldn't outlast one agent session.
- `tail.rs` doesn't use `notify` even though we depend on the crate. The
  dependency stays so we can swap in event-based detection later without
  another `Cargo.toml` change.
- `agenthub-tail/` (the CLI prototype) is committed alongside `app/`. Kept
  on purpose: it's a single-file demonstration of "agents leave JSONL audit
  trails, and that's enough" — useful as a minimum reproducible example
  when explaining the project.
- `risk.rs` lives in the Rust crate even though the Risk Score is computed
  on the JS side. The Rust copy is unused but kept for future agreement:
  when we move scoring to the backend (so multiple views can share it),
  this is where it goes.

---

## How to extend

### Add a new agent
1. Inspect its session-log format. Most agents emit JSONL these days.
2. Add `agent/<name>.rs` that exports `parse_line(line, …) -> Option<AgentEvent>`.
3. Add the directory to `tail.rs` discovery (`scan_dir(..., Source::<Name>)`).
4. Add `Agent::<Name>` enum variant + `label()` mapping.
5. Frontend: add a color to `agent-<name>` CSS class. That's it.

### Add a new risk rule
- For *live activity*: extend `agent/risk.rs::score()`.
- For *config*: extend the matching `scan_*` in `policy.rs`. Update
  `pi-tag.tag-<your-tag>` CSS class with a color.

### Add a new view
- Add a variant to the `View` type union in `App.tsx`.
- Add a Tab button.
- Write a `<YourView />` component. Read DB via `invoke("<command>")`. If
  you need the live event stream, subscribe to `agent-event` with the
  `cancelled` flag pattern.

### Add a new Tauri command
- Function with `#[tauri::command]` in `lib.rs`.
- Register it in the `tauri::generate_handler![…]` list.
- Frontend: `await invoke<ReturnType>("<name>", { args })`.

---

## What's deliberately small

The codebase is intentionally tight (~3k LOC frontend + Rust combined as of
this writing). When you find yourself reaching for a router, a state
library, a UI kit, a logger framework — first ask whether the problem can be
solved with another 20 lines in the existing files. Most can.
