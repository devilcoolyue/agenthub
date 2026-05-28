# Backlog

Tactical task list. Each item is small enough to ship in one focused session.
Grouped by area. Strikethrough = done.

For the bigger picture, see [`ROADMAP.md`](ROADMAP.md).

---

## Release (Phase 1 — do first)

- [x] `git init` and first commit; push to a new GitHub repo
- [x] Add `LICENSE` (MIT)
- [x] Add `.gitignore` covering `target/`, `node_modules/`, `dist/`,
      `*.bak.*`, `events.db*`
- [ ] Record demo GIF: Activity → Risk spike → Policy → batch remove. ~30s.
- [x] Capture 4 PNG screenshots under `assets/` (referenced from README)
- [x] GitHub Actions: `macos-latest` builds `.dmg` on tag push
      (`.github/workflows/release.yml`, both arm64 + x64)
- [x] First-launch banner: "Indexing your AI history…" — backfill kicks
      off automatically when the `events` table is empty
- [ ] Landing copy at top of README (hero + 3 value props from PRD §12)
- [x] Tauri auto-updater (signed releases). `UpdateBanner` checks on launch
      via the updater plugin; release workflow signs the `.app.tar.gz` and
      emits `latest.json`. Needs the `TAURI_SIGNING_PRIVATE_KEY` repo secret.

---

## Activity view

- [ ] Live Session Detail — currently SessionDetailView is a one-shot
      `get_session_events` call; subscribe to `agent-event` filtered by
      `session_id` and append in real time
- [x] Filter by tool name — top-N most-frequent tool_use chips, derived
      from the current event window; selected chip stays sticky.
- [ ] FTS5 over `data->>'$.kind.summary'` for full-text search across
      events (Bash command body, file paths)
- [ ] "Pin" an event to keep it visible while autoscroll continues
- [x] Hide `usage` rows by default — toolbar toggle defaults off.
- [x] Click event → jumps to its session detail (session-level for now;
      scrolling to the specific row in the timeline is still TODO).

---

## Sessions

- [ ] Sidebar real-time update — when a new session is created, push it
      into the categories without requiring tab switch
- [ ] Group cwds by project root (`.git` parent) instead of one entry per
      distinct cwd — collapses `agenthub/app` and `agenthub/app/src-tauri`
- [ ] Pre-fetch categories on app launch so first tab open is instant
- [ ] Pin / star sessions
- [ ] Export single session as JSON / markdown transcript

---

## Cost

- [ ] **Backfill cost for legacy rows.** Events imported before the
      `cost_micros` column existed have `cost_micros = 0`. Walk
      `events` where `cost_micros = 0 AND data LIKE '%"usage"%'`,
      reparse, fill. One-shot SQL or a Rust pass.
- [ ] Configurable per-model pricing via a JSON file (subscription users
      see different numbers than API-list-price users)
- [ ] Monthly budget setting + soft warning when approaching
- [ ] Cost by session (drill from Sessions card → Cost contribution)
- [ ] Cost by cwd / project — "this repo cost you $42 this month"
- [x] Codex model detection — seed `CodexState` from `~/.codex/config.toml`
      (active `profile` model, else top-level `model`) so usage rows that
      arrive before `turn_context` get the right model. Returns unknown
      (None) when the config doesn't pin a model — we don't guess.

---

## Policy

- [ ] **MCP server enable/disable toggle** — currently we only read,
      can't toggle individual servers
- [ ] Diff view in confirm modal — show `old → new` of the file before
      apply, not just a count
- [ ] Risk finding → Policy deep-link (Activity row → Policy item)
- [ ] Policy templates (`strict` / `dev` / `relaxed`) one-click apply
- [ ] `.agenthub/policy.yaml` per repo
- [ ] Drift detection — periodic diff vs. last seen state, surface what
      *the agent itself* added to your config
- [ ] Cleanup `.agenthub.bak.*` files older than 30 days (with a
      reverse-undo guard)

---

## Adapters

- [x] Cursor adapter (read-only: settings + rules + MCP). Static
      `AgentPolicy` card, no Activity events. Reads `~/.cursor/mcp.json`,
      `~/.cursor/rules/*.mdc` + legacy `~/.cursorrules`, and the JSONC
      `User/settings.json` (proxy + cursor-specific keys). All items
      read-only (no Remove button).
- [ ] Gemini CLI adapter (need to discover session format)
- [ ] OpenHands adapter
- [ ] Generic JSONL adapter ("point AgentHub at a directory pattern")

---

## Backend / DB

- [ ] Periodic prune — keep last 30 days OR last 200k events
- [ ] Schema version table + explicit migrations (currently we abuse
      `ALTER TABLE ADD COLUMN` with error swallowing)
- [ ] Sessions stats incremental update for new aggregates as we add them
- [ ] Run backfill automatically on first launch (when events table is
      empty) so users don't have to find the button
- [ ] Dedup hash: include a position-derived field so two assistant
      messages with identical content within one minute aren't merged

---

## UI polish

- [ ] Settings page (data dir location, pricing, retention, theme)
- [ ] Light theme option
- [ ] Resize-aware layout for narrow windows
- [ ] Keyboard shortcuts (⌘1–4 to switch tabs, `/` to focus search)
- [ ] In-app changelog when AgentHub updates itself
- [ ] Empty states with "what to do next" hints

---

## Known issues / tech debt

- [ ] `agenthub-tail` CLI (the original prototype) and `app/src-tauri`
      duplicate the parser code. Either delete the CLI or extract a
      shared crate.
- [x] Codex `model` is read from `session_meta` which is often `null`.
      No longer hard-codes `gpt-5`: seeds from `~/.codex/config.toml`
      (`[profiles.<active>].model` or top-level `model`), then lets
      `turn_context` override. Unknown stays None rather than a wrong guess.
- [ ] `classify_assistant` in `claude.rs` only returns the *first*
      content block of an assistant message. If a message has both
      `thinking` and `tool_use`, the `thinking` is lost.
- [ ] `EventKind::Usage` events render as a faint utility row but still
      count toward the in-memory events list. Could be filtered for
      cleaner Activity tab.
- [ ] `RiskLevel` enum in `risk.rs` is unused in the Rust side (used
      only on the JS side). Either remove from Rust or wire up.
- [ ] WAL file (`events.db-wal`) can grow large; checkpoint periodically.

---

## How to use this file

When you start a session, pick the most valuable unchecked item, copy the
text into a task in your conversation, and start. When it's done, change
`- [ ]` to `- [x]` here. Add new items as they emerge — every "we should
also…" thought belongs here so the next session doesn't re-derive it.
