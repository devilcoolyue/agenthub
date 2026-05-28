# Roadmap

Aligned with the five phases in [`AgentHub_PRD.md`](../AgentHub_PRD.md), updated with current reality.

---

## Phase 0 — Activity Monitor MVP  ✅ done

Built and shipped locally:

- Live Activity Stream (Claude Code, Codex)
- Timeline drill-down via Session Detail
- Risk Score (0–100) over last 200 events
- Sessions browser (categorized by project, lazy-loaded, searchable)
- Cost / token dashboard with cache-aware pricing
- Policy view: per-item and batch removal, hooks parsing, undo/restore
- SQLite persistence with materialized sessions table
- Backfill from JSONL sources, idempotent via SHA-256 event hash

---

## Phase 1 — Ship It  (current focus)

Goal: get AgentHub in front of users. Functionality is enough; what's missing
is the "first 10 seconds" experience and the release pipeline.

### Must-do before public release

- [x] **git init** the repo + first commit. Pushed to
      `github.com/devilcoolyue/agenthub`.
- [x] **`LICENSE`** file (MIT).
- [x] **Screenshots** for the README hero (`assets/*.png`). Still missing
      a demo GIF that walks Activity → Risk spike → Policy → batch remove.
- [x] **First-launch onboarding banner** — when the events table is empty
      we auto-trigger backfill and surface a "Indexing your AI history…"
      banner so a brand-new user immediately sees something happening.
- [x] **macOS `.dmg` release** via GitHub Actions, tag-driven
      (`.github/workflows/release.yml`). Builds both `aarch64-apple-darwin`
      and `x86_64-apple-darwin`, attaches DMGs to the GitHub Release.
- [ ] **landing copy** for the README first screen (text taken from the PRD
  spread-strategy section).

### Nice-to-have for v0.1

- [x] Auto-update infrastructure (Tauri updater) — checks GitHub Releases'
      `latest.json` on launch and offers a one-click download + relaunch.
      Updates are minisign-signed in CI (`TAURI_SIGNING_PRIVATE_KEY`).
- [ ] Issue templates + CONTRIBUTING.md
- [ ] Crash report opt-in (anonymous; optional; off by default)

---

## Phase 2 — Multi-Agent Coverage  (1–2 months out)

Goal: finish the "all your AI agents in one place" claim.

- [x] **Cursor adapter**. Cursor has no JSONL audit log, so this is a
  *static* view: reads `~/.cursor/mcp.json`, `~/.cursor/rules/` (+ legacy
  `~/.cursorrules`), and the JSONC `User/settings.json` to surface MCP
  servers, rules, and settings. Activity remains Claude / Codex only;
  rendered as a read-only "configuration-only" card in Policy.
- [ ] **Gemini CLI adapter** (live, similar to Codex once we see their
  session format).
- [ ] **OpenHands adapter** if user demand appears.
- [x] **Multi-agent dashboard** — per-agent overview band atop the Dashboard
  view: status (active/idle/config-only), today's events, today's $, and
  risk (today's high-risk activity + policy config flagged) for claude-code,
  codex, and cursor. Backed by `get_today_agent_stats` + reused
  `get_daily_cost`/`get_agent_policies`.
- [ ] **Live Session Detail** — currently a snapshot; subscribe to
  `agent-event` filtered by `session_id` and append in real time.

---

## Phase 3 — Policy Engine  (PRD Phase 2)

Goal: move from "see and remove" to "declarative policy that the system enforces".

- [ ] **Policy templates** — recommended baselines (`strict`, `dev`,
  `relaxed`). One-click apply against a Claude / Codex config.
- [ ] **`.agenthub/policy.yaml` per repo** — team-shared policy file.
  E.g. `deny: ["~/.ssh/**", ".env", "rm -rf"]`. Loaded automatically when
  agents work in that repo.
- [ ] **MCP server toggle** — disable / enable individual MCP entries from
  the UI. Currently we only display them.
- [ ] **Risk findings → Policy deep-link** — clicking a "shell-dangerous"
  event in Activity jumps to the offending permission rule in Policy.
- [ ] **Diff view** before write — show "old → new" of the config file
  before atomic write, not just a count.
- [ ] **Policy diff in commit hooks** — optional pre-commit hook that
  fails if a teammate adds a `secret-in-rule` to settings.

---

## Phase 4 — MCP Ecosystem  (PRD Phase 3)

Goal: solve the "MCP is a black box" problem.

- [ ] **Verified MCP registry** — community-curated trust signals
- [ ] **MCP telemetry** — what each MCP server actually called during a session
- [ ] **Safe MCP profiles** — per-MCP capability scopes (fs / shell /
  network) with one-click downgrade
- [ ] **MCP reviews** — short user-contributed risk notes

---

## Phase 5 — Enterprise  (PRD Phase 4)

Goal: data the security team needs.

- [ ] **Audit log export** (CSV, JSON, SIEM-friendly)
- [ ] **Token / cost budgets** with alerts (Slack webhook, email)
- [ ] **Team rollups** — aggregate dashboards across multiple machines
  (requires opt-in central sync — out of pure-local scope)
- [ ] **Compliance reports** — flag config drift from policy baseline
- [ ] **Access control** for the dashboard itself (Touch ID / lock)

---

## Phase 6 — AI Native OS Layer  (PRD Phase 5 / long-term)

The horizon. Not committed; depends on whether the lower phases find real
traction.

- Agent CPU scheduling
- Per-agent token budgets enforced at runtime
- Shared context memory across agents
- Process isolation / sandboxing
- Runtime orchestration ("run this prompt on the cheapest model that
  passes spec")

---

## Non-goals

To stay focused, AgentHub will **not** become:

- A general-purpose terminal logger / shell history tool
- An IDE plugin (we monitor *all* agents; we don't live inside one)
- A cloud SaaS (data stays local)
- A model-routing proxy
- An LLM evaluation suite

---

## How to use this file

When you pick the next thing to build, copy the relevant `- [ ]` line into
[`BACKLOG.md`](BACKLOG.md), break it into concrete tasks, and check it off
here when the feature lands.
