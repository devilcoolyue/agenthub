import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  Agent,
  AgentEvent,
  AgentPolicy,
  BackfillProgress,
  BackupInfo,
  BatchResult,
  DailyCost,
  EventKind,
  ModelCost,
  PolicyItem,
  RiskSummary,
  SessionCategory,
  SessionSummary,
  SessionsFilter,
} from "./types";
import { riskLevel, computeRiskSummary, fmtTokens, fmtUSD } from "./types";
import "./App.css";

const MAX_EVENTS = 500;

type View =
  | { type: "activity" }
  | { type: "sessions" }
  | { type: "session-detail"; sessionId: string }
  | { type: "cost" }
  | { type: "policy" };

function App() {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [view, setView] = useState<View>({ type: "activity" });
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  const [isFirstRun, setIsFirstRun] = useState(false);
  // bumps each time backfill completes so views requery
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let un: UnlistenFn | undefined;
    (async () => {
      const u = await listen<BackfillProgress>("backfill-progress", (e) => {
        setBackfill(e.payload);
        if (e.payload.phase === "done" || e.payload.phase === "failed") {
          setRefreshKey((k) => k + 1);
          // auto-dismiss after 5s, then clear the first-run flag too
          setTimeout(() => {
            setBackfill(null);
            setIsFirstRun(false);
          }, 5000);
        }
      });
      if (cancelled) u();
      else un = u;
    })();
    return () => {
      cancelled = true;
      if (un) un();
    };
  }, []);

  // First-launch auto-backfill: if the DB is empty, kick off an import so a
  // brand-new user sees their history populating instead of an empty window.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const count = await invoke<number>("get_event_count");
        if (cancelled || count > 0) return;
        setIsFirstRun(true);
        setBackfill({ phase: "started" });
        await invoke("start_backfill");
      } catch (err) {
        if (!cancelled) {
          setBackfill({ phase: "failed", error: String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const startBackfill = async () => {
    setBackfill({ phase: "started" });
    try {
      await invoke("start_backfill");
    } catch (err) {
      setBackfill({ phase: "failed", error: String(err) });
    }
  };

  const isBackfillRunning =
    backfill !== null && backfill.phase !== "done" && backfill.phase !== "failed";

  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | undefined;
    (async () => {
      const recent = await invoke<AgentEvent[]>("get_recent_events");
      if (cancelled) return;
      setEvents(recent.slice(-MAX_EVENTS));
      const u = await listen<AgentEvent>("agent-event", (e) => {
        setEvents((prev) => {
          const next = prev.length >= MAX_EVENTS ? prev.slice(prev.length - MAX_EVENTS + 1) : prev.slice();
          next.push(e.payload);
          return next;
        });
      });
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    })();
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  const stats = useMemo(() => {
    const byAgent: Record<string, number> = {};
    for (const e of events) {
      byAgent[e.agent] = (byAgent[e.agent] ?? 0) + 1;
    }
    return { byAgent, total: events.length };
  }, [events]);

  const risk = useMemo(() => computeRiskSummary(events), [events]);

  return (
    <div className="app">
      <header className={`header level-${risk.level}`}>
        <div className="header-left">
          <div className="brand">
            <span className="logo-dot" />
            <span className="brand-name">AgentHub</span>
            <span className="brand-tag">Activity Monitor for AI Agents</span>
            <button
              className="header-tool"
              onClick={startBackfill}
              disabled={isBackfillRunning}
              title="Re-scan all Claude Code and Codex JSONL sessions into the local DB. Safe to run anytime — duplicates are skipped."
            >
              {isBackfillRunning ? "Backfilling…" : "Backfill from sources"}
            </button>
          </div>
          <div className="stats">
            <Stat label="events" value={stats.total} />
            <Stat label="claude-code" value={stats.byAgent["claude-code"] ?? 0} accent="cyan" />
            <Stat label="codex" value={stats.byAgent["codex"] ?? 0} accent="magenta" />
          </div>
        </div>
        <RiskCard risk={risk} />
      </header>

      {backfill && (
        <BackfillBanner
          p={backfill}
          firstRun={isFirstRun}
          onDismiss={() => setBackfill(null)}
        />
      )}

      <Tabs view={view} onView={setView} />

      {view.type === "activity" && <ActivityView events={events} />}
      {view.type === "sessions" && (
        <SessionsView
          key={`sessions-${refreshKey}`}
          onOpen={(id) => setView({ type: "session-detail", sessionId: id })}
        />
      )}
      {view.type === "session-detail" && (
        <SessionDetailView
          key={`detail-${view.sessionId}-${refreshKey}`}
          sessionId={view.sessionId}
          onBack={() => setView({ type: "sessions" })}
        />
      )}
      {view.type === "cost" && <CostView key={`cost-${refreshKey}`} />}
      {view.type === "policy" && <PolicyView />}
    </div>
  );
}

function Tabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const tab: "activity" | "sessions" | "cost" | "policy" =
    view.type === "session-detail" ? "sessions" : view.type;
  return (
    <nav className="tabs">
      <button
        className={`tab ${tab === "activity" ? "active" : ""}`}
        onClick={() => onView({ type: "activity" })}
      >
        Activity
      </button>
      <button
        className={`tab ${tab === "sessions" ? "active" : ""}`}
        onClick={() => onView({ type: "sessions" })}
      >
        Sessions
      </button>
      <button
        className={`tab ${tab === "cost" ? "active" : ""}`}
        onClick={() => onView({ type: "cost" })}
      >
        Cost
      </button>
      <button
        className={`tab ${tab === "policy" ? "active" : ""}`}
        onClick={() => onView({ type: "policy" })}
      >
        Policy
      </button>
    </nav>
  );
}

/* ---------- Activity view ---------- */

function ActivityView({ events }: { events: AgentEvent[] }) {
  const [filterAgent, setFilterAgent] = useState<Agent | "all">("all");
  const [filterRisk, setFilterRisk] = useState<"all" | "med+" | "high">("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  const filtered = useMemo(
    () =>
      events.filter((ev) => {
        if (filterAgent !== "all" && ev.agent !== filterAgent) return false;
        if (filterRisk === "high" && riskLevel(ev.risk_tags) !== "high") return false;
        if (filterRisk === "med+" && riskLevel(ev.risk_tags) === "low") return false;
        return true;
      }),
    [events, filterAgent, filterRisk],
  );

  return (
    <>
      <div className="toolbar">
        <FilterGroup
          label="agent"
          value={filterAgent}
          options={[
            { v: "all", l: "all" },
            { v: "claude-code", l: "claude-code" },
            { v: "codex", l: "codex" },
          ]}
          onChange={(v) => setFilterAgent(v as Agent | "all")}
        />
        <FilterGroup
          label="risk"
          value={filterRisk}
          options={[
            { v: "all", l: "all" },
            { v: "med+", l: "≥ medium" },
            { v: "high", l: "high only" },
          ]}
          onChange={(v) => setFilterRisk(v as "all" | "med+" | "high")}
        />
        <label className="toggle">
          <input
            type="checkbox"
            checked={autoScroll}
            onChange={(e) => setAutoScroll(e.target.checked)}
          />
          auto-scroll
        </label>
      </div>

      <div className="event-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="empty">
            no activity yet — open Claude Code, Codex, or your editor and do something.
          </div>
        )}
        {filtered.map((ev, i) => (
          <EventRow key={i} ev={ev} />
        ))}
      </div>
    </>
  );
}

/* ---------- Sessions list view ---------- */

type CategorySelection =
  | { kind: "all" }
  | { kind: "high-risk" }
  | { kind: "cwd"; cwd: string | null };

const PAGE_SIZE = 20;

function SessionsView({ onOpen }: { onOpen: (sessionId: string) => void }) {
  const [categories, setCategories] = useState<SessionCategory[] | null>(null);
  const [selected, setSelected] = useState<CategorySelection>({ kind: "all" });
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const offsetRef = useRef(0);
  const reqIdRef = useRef(0); // guard against out-of-order responses
  const sentinelRef = useRef<HTMLDivElement>(null);
  const listScrollRef = useRef<HTMLDivElement>(null);

  // load categories once on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await invoke<SessionCategory[]>("list_session_categories");
      if (!cancelled) setCategories(list);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // debounce search input → query
  useEffect(() => {
    const id = window.setTimeout(() => setQuery(searchInput.trim()), 200);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  // load first page whenever filter changes
  useEffect(() => {
    const reqId = ++reqIdRef.current;
    offsetRef.current = 0;
    setSessions([]);
    setHasMore(true);
    setLoading(true);
    (async () => {
      const list = await invoke<SessionSummary[]>("list_sessions", {
        filter: buildFilter(selected, query),
        limit: PAGE_SIZE,
        offset: 0,
      });
      if (reqId !== reqIdRef.current) return; // stale
      setSessions(list);
      offsetRef.current = list.length;
      setHasMore(list.length === PAGE_SIZE);
      setLoading(false);
      if (listScrollRef.current) listScrollRef.current.scrollTop = 0;
    })();
  }, [selected, query]);

  const loadMore = useCallback(async () => {
    if (loading || !hasMore) return;
    const reqId = reqIdRef.current;
    setLoading(true);
    const list = await invoke<SessionSummary[]>("list_sessions", {
      filter: buildFilter(selected, query),
      limit: PAGE_SIZE,
      offset: offsetRef.current,
    });
    if (reqId !== reqIdRef.current) return;
    setSessions((prev) => [...prev, ...list]);
    offsetRef.current += list.length;
    setHasMore(list.length === PAGE_SIZE);
    setLoading(false);
  }, [loading, hasMore, selected, query]);

  // IntersectionObserver for infinite scroll
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) loadMore();
      },
      { root: listScrollRef.current, rootMargin: "200px" },
    );
    obs.observe(node);
    return () => obs.disconnect();
  }, [loadMore]);

  if (categories === null) return <div className="empty">loading sessions…</div>;

  return (
    <div className="sessions-layout">
      <aside className="sessions-sidebar">
        <SidebarItem
          label="All sessions"
          count={categories.reduce((a, c) => a + c.session_count, 0)}
          selected={selected.kind === "all"}
          onClick={() => setSelected({ kind: "all" })}
        />
        {(() => {
          const totalHigh = categories.reduce((a, c) => a + c.high_risk_session_count, 0);
          if (totalHigh === 0) return null;
          return (
            <SidebarItem
              label="High risk"
              count={totalHigh}
              danger
              selected={selected.kind === "high-risk"}
              onClick={() => setSelected({ kind: "high-risk" })}
            />
          );
        })()}
        <div className="sidebar-section-label">PROJECTS</div>
        <div className="sidebar-projects">
          {categories.map((c) => (
            <SidebarItem
              key={c.cwd ?? "__none__"}
              label={cwdLabel(c.cwd)}
              sublabel={c.cwd ?? undefined}
              count={c.session_count}
              riskCount={c.high_risk_session_count}
              selected={
                selected.kind === "cwd" &&
                (selected.cwd ?? "__none__") === (c.cwd ?? "__none__")
              }
              onClick={() => setSelected({ kind: "cwd", cwd: c.cwd })}
            />
          ))}
        </div>
      </aside>

      <main className="sessions-main">
        <div className="sessions-toolbar">
          <input
            type="text"
            className="sessions-search"
            placeholder="search by path or session id…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="search-clear" onClick={() => setSearchInput("")}>
              ×
            </button>
          )}
        </div>

        <div className="sessions-list" ref={listScrollRef}>
          {sessions.length === 0 && !loading && (
            <div className="empty">no sessions match this filter.</div>
          )}
          {sessions.map((s) => (
            <SessionCard
              key={s.session_id}
              s={s}
              onClick={() => onOpen(s.session_id)}
            />
          ))}
          <div ref={sentinelRef} className="sentinel">
            {loading
              ? "loading more…"
              : hasMore
              ? "scroll for more"
              : sessions.length > 0
              ? `${sessions.length} sessions · end`
              : ""}
          </div>
        </div>
      </main>
    </div>
  );
}

function buildFilter(sel: CategorySelection, query: string) {
  const f: SessionsFilter = {};
  if (sel.kind === "cwd") f.cwd = sel.cwd;
  if (sel.kind === "high-risk") f.high_risk_only = true;
  if (query) f.query = query;
  return f;
}

function cwdLabel(cwd: string | null): string {
  if (!cwd) return "(no cwd)";
  const stripped = cwd.replace(/^\/Users\/[^/]+\//, "");
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 0) return stripped || cwd;
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

function SidebarItem({
  label,
  sublabel,
  count,
  riskCount,
  selected,
  danger,
  onClick,
}: {
  label: string;
  sublabel?: string;
  count: number;
  riskCount?: number;
  selected: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`sidebar-item ${selected ? "selected" : ""} ${danger ? "danger" : ""}`}
      onClick={onClick}
      title={sublabel ?? ""}
    >
      <span className="sb-label">{label}</span>
      <span className="sb-counts">
        {riskCount && riskCount > 0 ? (
          <span className="sb-risk">{riskCount}</span>
        ) : null}
        <span className="sb-count">{count}</span>
      </span>
    </button>
  );
}

function SessionCard({ s, onClick }: { s: SessionSummary; onClick: () => void }) {
  const isHigh = s.high_risk_count > 0;
  return (
    <button className={`session-card ${isHigh ? "high" : ""}`} onClick={onClick}>
      <div className="sc-row1">
        <span className={`agent agent-${s.agent}`}>{s.agent}</span>
        <span className="sc-session-id">{s.session_id.slice(0, 8)}</span>
        {isHigh && <span className="sc-risk-pill">{s.high_risk_count} high-risk</span>}
      </div>
      <div className="sc-cwd" title={s.cwd ?? ""}>{shortenCwd(s.cwd) || "—"}</div>
      <div className="sc-row3">
        <span>
          <span className="sc-num">{s.event_count}</span>
          <span className="sc-num-label"> events</span>
        </span>
        <span>
          <span className="sc-num">{s.tool_count}</span>
          <span className="sc-num-label"> tools</span>
        </span>
        <span className="sc-when" title={`${s.start_ts} → ${s.end_ts}`}>
          {formatRange(s.start_ts, s.end_ts)}
        </span>
      </div>
    </button>
  );
}

/* ---------- Session detail view ---------- */

function SessionDetailView({
  sessionId,
  onBack,
}: {
  sessionId: string;
  onBack: () => void;
}) {
  const [events, setEvents] = useState<AgentEvent[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await invoke<AgentEvent[]>("get_session_events", { sessionId });
      if (!cancelled) setEvents(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  const meta = useMemo(() => {
    if (!events || events.length === 0) return null;
    const agent = events[0].agent;
    let cwd: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].cwd) { cwd = events[i].cwd; break; }
    }
    const start = events[0].timestamp;
    const end = events[events.length - 1].timestamp;
    const high = events.filter((e) => riskLevel(e.risk_tags) === "high").length;
    return { agent, cwd, start, end, high };
  }, [events]);

  return (
    <>
      <div className="detail-header">
        <button className="back-btn" onClick={onBack}>← sessions</button>
        {meta && (
          <div className="detail-meta">
            <span className={`agent agent-${meta.agent}`}>{meta.agent}</span>
            <span className="meta-sep">·</span>
            <span className="detail-cwd" title={meta.cwd ?? ""}>{shortenCwd(meta.cwd)}</span>
            <span className="meta-sep">·</span>
            <span>{events!.length} events</span>
            {meta.high > 0 && (
              <>
                <span className="meta-sep">·</span>
                <span className="detail-high">{meta.high} high-risk</span>
              </>
            )}
            <span className="meta-sep">·</span>
            <span className="detail-when">{formatRange(meta.start, meta.end)}</span>
          </div>
        )}
        <span className="detail-id">{sessionId}</span>
      </div>
      <div className="event-list">
        {events === null && <div className="empty">loading session…</div>}
        {events && events.length === 0 && <div className="empty">no events.</div>}
        {events?.map((ev, i) => (
          <EventRow key={i} ev={ev} />
        ))}
      </div>
    </>
  );
}

/* ---------- Cost view ---------- */

function CostView() {
  const [daily, setDaily] = useState<DailyCost[] | null>(null);
  const [models, setModels] = useState<ModelCost[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [d, m] = await Promise.all([
        invoke<DailyCost[]>("get_daily_cost", { days: 30 }),
        invoke<ModelCost[]>("get_model_cost", { days: 30 }),
      ]);
      if (cancelled) return;
      setDaily(d);
      setModels(m);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (daily === null || models === null)
    return <div className="empty">loading cost data…</div>;

  if (daily.length === 0)
    return (
      <div className="empty">
        no cost data yet — use Claude Code or Codex to generate some token usage.
      </div>
    );

  // Build daily totals (sum across agents) and 7-day window for the chart
  const todayLocal = new Date();
  const todayKey = ymdLocal(todayLocal);
  const yesterdayKey = ymdLocal(new Date(todayLocal.getTime() - 86400000));

  const byDay = new Map<string, { total: number; perAgent: Record<string, number> }>();
  for (const d of daily) {
    const slot = byDay.get(d.day) ?? { total: 0, perAgent: {} };
    slot.total += d.cost_micros;
    slot.perAgent[d.agent] = (slot.perAgent[d.agent] ?? 0) + d.cost_micros;
    byDay.set(d.day, slot);
  }

  const todayMicros = byDay.get(todayKey)?.total ?? 0;
  const yesterdayMicros = byDay.get(yesterdayKey)?.total ?? 0;
  const deltaPct =
    yesterdayMicros > 0
      ? ((todayMicros - yesterdayMicros) / yesterdayMicros) * 100
      : null;

  const todayByAgent = byDay.get(todayKey)?.perAgent ?? {};

  // 7-day chart (oldest → newest)
  const chartDays: { day: string; perAgent: Record<string, number>; total: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayLocal.getTime() - i * 86400000);
    const key = ymdLocal(d);
    const slot = byDay.get(key) ?? { total: 0, perAgent: {} };
    chartDays.push({ day: key, perAgent: slot.perAgent, total: slot.total });
  }
  const chartMax = Math.max(...chartDays.map((d) => d.total), 1);

  const total30 = daily.reduce((a, d) => a + d.cost_micros, 0);

  return (
    <div className="cost-view">
      {/* Top: Today big card + 30-day total */}
      <div className="cost-top">
        <div className="cost-today">
          <div className="cost-today-label">TODAY</div>
          <div className="cost-today-value">{fmtUSD(todayMicros)}</div>
          {deltaPct !== null && (
            <div
              className={`cost-delta ${
                deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : ""
              }`}
            >
              {deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "·"}{" "}
              {Math.abs(deltaPct).toFixed(0)}% vs yesterday
            </div>
          )}
          <div className="cost-today-breakdown">
            {Object.entries(todayByAgent).map(([a, v]) => (
              <div key={a} className="cost-line">
                <span className={`agent agent-${a}`}>{a}</span>
                <span className="cost-line-val">{fmtUSD(v)}</span>
              </div>
            ))}
            {Object.keys(todayByAgent).length === 0 && (
              <div className="cost-line dim">no activity today</div>
            )}
          </div>
        </div>

        <div className="cost-30d">
          <div className="cost-today-label">LAST 30 DAYS</div>
          <div className="cost-30d-value">{fmtUSD(total30)}</div>
          <div className="cost-30d-note">list price · estimated</div>
        </div>
      </div>

      {/* 7-day bar chart */}
      <div className="cost-section">
        <div className="cost-section-title">Last 7 days</div>
        <div className="cost-chart">
          {chartDays.map((d) => {
            const claudeCost = d.perAgent["claude-code"] ?? 0;
            const codexCost = d.perAgent["codex"] ?? 0;
            const claudePct = (claudeCost / chartMax) * 100;
            const codexPct = (codexCost / chartMax) * 100;
            const dayDate = new Date(d.day + "T00:00:00");
            const dayLabel =
              d.day === todayKey
                ? "today"
                : d.day === yesterdayKey
                ? "yest"
                : dayDate.toLocaleDateString("en-US", {
                    weekday: "short",
                    month: "numeric",
                    day: "numeric",
                  });
            return (
              <div key={d.day} className="bar-col">
                <div className="bar-value">{d.total > 0 ? fmtUSD(d.total) : ""}</div>
                <div className="bar-stack">
                  <div
                    className="bar-codex"
                    style={{ height: `${codexPct}%` }}
                    title={`codex: ${fmtUSD(codexCost)}`}
                  />
                  <div
                    className="bar-claude"
                    style={{ height: `${claudePct}%` }}
                    title={`claude-code: ${fmtUSD(claudeCost)}`}
                  />
                </div>
                <div className="bar-label">{dayLabel}</div>
              </div>
            );
          })}
        </div>
        <div className="cost-legend">
          <span className="legend-item">
            <span className="legend-swatch swatch-claude" /> claude-code
          </span>
          <span className="legend-item">
            <span className="legend-swatch swatch-codex" /> codex
          </span>
        </div>
      </div>

      {/* By model */}
      <div className="cost-section">
        <div className="cost-section-title">By model · last 30 days</div>
        <div className="model-table">
          <div className="model-row head">
            <div>model</div>
            <div>input</div>
            <div>cache read</div>
            <div>cache create</div>
            <div>output</div>
            <div>cost</div>
          </div>
          {models.map((m) => (
            <div key={m.model} className="model-row">
              <div className="model-name">{m.model}</div>
              <div>{fmtTokens(m.input_tokens)}</div>
              <div className="dim">{fmtTokens(m.cache_read_tokens)}</div>
              <div className="dim">{fmtTokens(m.cache_creation_tokens)}</div>
              <div>{fmtTokens(m.output_tokens)}</div>
              <div className="cost-cell">{fmtUSD(m.cost_micros)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function ymdLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/* ---------- Policy view ---------- */

interface PendingBatch {
  items: PolicyItem[];
  label: string; // descriptive title for the modal
}

function PolicyView() {
  const [policies, setPolicies] = useState<AgentPolicy[] | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingBatch | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const reload = useCallback(async () => {
    const [pol, bks] = await Promise.all([
      invoke<AgentPolicy[]>("get_agent_policies"),
      invoke<BackupInfo[]>("list_policy_backups", { limit: 20 }),
    ]);
    setPolicies(pol);
    setBackups(bks);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const requestRemove = (item: PolicyItem) => {
    if (!item.remove_action) return;
    setConfirming({ items: [item], label: `Remove this ${item.category.replace("-", " ")}` });
  };

  const requestBatch = (items: PolicyItem[], description: string) => {
    const filtered = items.filter((i) => i.remove_action);
    if (filtered.length === 0) return;
    setConfirming({ items: filtered, label: description });
  };

  const doRemove = async () => {
    const batch = confirming;
    if (!batch) return;
    setConfirming(null);
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      if (batch.items.length === 1) {
        await invoke("remove_policy_item", { action: batch.items[0].remove_action });
        setSuccess(`Removed 1 item`);
      } else {
        const actions = batch.items.map((i) => i.remove_action);
        const result = await invoke<BatchResult>("remove_policy_items", { actions });
        if (result.failed.length > 0) {
          setError(
            `Removed ${result.removed}, failed:\n${result.failed.join("\n")}`,
          );
        } else {
          setSuccess(`Removed ${result.removed} items`);
        }
      }
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const doRestore = async (b: BackupInfo) => {
    if (
      !window.confirm
    ) {
      // window.confirm unreliable in Tauri; use a simpler inline confirm
    }
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await invoke("restore_policy_backup", {
        backupPath: b.backup_path,
        originalPath: b.original_path,
      });
      setSuccess(`Restored ${b.original_path.split("/").pop()}`);
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  if (policies === null) return <div className="empty">loading policy…</div>;
  if (policies.length === 0)
    return <div className="empty">no agent config found.</div>;

  return (
    <div className="policy-view">
      {error && <div className="policy-error">{error}</div>}
      {success && <div className="policy-success">{success}</div>}

      {backups.length > 0 && (
        <details
          className="history-panel"
          open={historyOpen}
          onToggle={(e) => setHistoryOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            Recent changes
            <span className="history-count">{backups.length}</span>
            <span className="history-hint">— click to restore from .bak</span>
          </summary>
          <ul className="history-list">
            {backups.map((b) => (
              <li key={b.backup_path} className="history-row">
                <div className="hr-main">
                  <div className="hr-file">
                    {b.original_path.replace(/^\/Users\/[^/]+/, "~")}
                  </div>
                  <div className="hr-meta">
                    {new Date(b.timestamp).toLocaleString()} ·{" "}
                    {(b.size_bytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  onClick={() => doRestore(b)}
                  disabled={pending}
                  title={b.backup_path}
                >
                  Restore
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {policies.map((p) => (
        <PolicyCard
          key={p.agent}
          p={p}
          pending={pending}
          onRemove={requestRemove}
          onBatch={requestBatch}
        />
      ))}
      {confirming && (
        <ConfirmRemoveModal
          batch={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={doRemove}
        />
      )}
    </div>
  );
}

function ConfirmRemoveModal({
  batch,
  onCancel,
  onConfirm,
}: {
  batch: PendingBatch;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const previewLimit = 8;
  const preview = batch.items.slice(0, previewLimit);
  const filesAffected = Array.from(
    new Set(batch.items.map((i) => i.source_path)),
  );

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {batch.label}{" "}
          <span className="modal-count">({batch.items.length})</span>
        </div>
        <pre className="modal-target">
          {preview.map((it) => it.label).join("\n")}
          {batch.items.length > previewLimit && (
            <>{"\n"}… and {batch.items.length - previewLimit} more</>
          )}
        </pre>
        <div className="modal-detail">
          {filesAffected.length === 1
            ? `Affects: ${filesAffected[0].replace(/^\/Users\/[^/]+/, "~")}`
            : `Affects ${filesAffected.length} files`}
        </div>
        <div className="modal-note">
          One timestamped <code>.agenthub.bak.&lt;ts&gt;</code> per affected file. Use the
          "Recent changes" panel to restore.
        </div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Cancel (Esc)
          </button>
          <button className="btn-danger" onClick={onConfirm} autoFocus>
            Remove {batch.items.length} (Enter)
          </button>
        </div>
      </div>
    </div>
  );
}

function PolicyCard({
  p,
  pending,
  onRemove,
  onBatch,
}: {
  p: AgentPolicy;
  pending: boolean;
  onRemove: (item: PolicyItem) => void;
  onBatch: (items: PolicyItem[], description: string) => void;
}) {
  // Group items by category for display
  const groups = new Map<string, PolicyItem[]>();
  for (const it of p.items) {
    const arr = groups.get(it.category) ?? [];
    arr.push(it);
    groups.set(it.category, arr);
  }
  const order: PolicyItem["category"][] = [
    "permission",
    "model-provider",
    "trusted-project",
    "mcp-server",
    "hook",
    "info",
  ];
  return (
    <div className={`policy-card ${p.high_risk_count > 0 ? "has-risk" : ""}`}>
      <div className="policy-card-head">
        <span className={`agent agent-${p.agent}`}>{p.agent}</span>
        {p.model && <span className="policy-model">{p.model}</span>}
        <span className="policy-files" title={p.config_files.join("\n")}>
          {p.config_files.length} config file{p.config_files.length === 1 ? "" : "s"}
        </span>
        {p.high_risk_count > 0 && (
          <span className="policy-risk-pill">{p.high_risk_count} flagged</span>
        )}
      </div>

      {order.map((cat) => {
        const items = groups.get(cat);
        if (!items || items.length === 0) return null;
        const title = CATEGORY_LABELS[cat] ?? cat;
        const flagged = items.filter((i) => i.risk_tags.length > 0).length;

        // Bucket items by each risk tag they carry → support "remove all with tag X"
        const tagBuckets = new Map<string, PolicyItem[]>();
        for (const it of items) {
          for (const tag of it.risk_tags) {
            const arr = tagBuckets.get(tag) ?? [];
            arr.push(it);
            tagBuckets.set(tag, arr);
          }
        }
        const bulkTags = Array.from(tagBuckets.entries())
          .filter(([, arr]) => arr.length >= 2 && arr.some((x) => x.remove_action))
          .sort((a, b) => b[1].length - a[1].length);

        return (
          <section className="policy-section" key={cat}>
            <header className="policy-section-head">
              <span className="ps-title">{title}</span>
              <span className="ps-count">
                {items.length}
                {flagged > 0 && <span className="ps-flagged"> · {flagged} flagged</span>}
              </span>
            </header>
            {bulkTags.length > 0 && (
              <div className="bulk-actions">
                {bulkTags.map(([tag, arr]) => (
                  <button
                    key={tag}
                    className={`bulk-btn tag-${tag}`}
                    disabled={pending}
                    onClick={() =>
                      onBatch(arr, `Remove all ${arr.length} entries tagged "${tag}"`)
                    }
                  >
                    Remove all {arr.length} with <code>{tag}</code>
                  </button>
                ))}
              </div>
            )}
            <ul className="policy-items">
              {items.map((it, i) => (
                <PolicyRow
                  key={`${cat}-${i}`}
                  it={it}
                  pending={pending}
                  onRemove={() => onRemove(it)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

const CATEGORY_LABELS: Record<string, string> = {
  permission: "Permission allow-list",
  "model-provider": "Model providers",
  "trusted-project": "Trusted projects",
  "mcp-server": "MCP servers",
  hook: "Hooks",
  info: "Notes",
};

function PolicyRow({
  it,
  pending,
  onRemove,
}: {
  it: PolicyItem;
  pending: boolean; // any policy op is in-flight
  onRemove: () => void;
}) {
  const high = it.risk_tags.length > 0;
  return (
    <li className={`policy-item ${high ? "flagged" : ""}`}>
      <div className="pi-main">
        <div className="pi-label" title={it.label}>{it.label}</div>
        {it.detail && <div className="pi-detail">{it.detail}</div>}
        {it.risk_tags.length > 0 && (
          <div className="pi-tags">
            {it.risk_tags.map((t) => (
              <span key={t} className={`pi-tag tag-${t}`}>
                {t}
              </span>
            ))}
          </div>
        )}
      </div>
      {it.remove_action && (
        <button
          className="pi-remove"
          onClick={onRemove}
          disabled={pending}
        >
          {pending ? "…" : "Remove"}
        </button>
      )}
    </li>
  );
}

/* ---------- Backfill banner ---------- */

function BackfillBanner({
  p,
  firstRun,
  onDismiss,
}: {
  p: BackfillProgress;
  firstRun: boolean;
  onDismiss: () => void;
}) {
  let label = "";
  let cls = "info";
  switch (p.phase) {
    case "started":
      label = firstRun
        ? "Welcome to AgentHub. Indexing your AI history from ~/.claude and ~/.codex…"
        : "Backfill starting…";
      break;
    case "hashes_migrated":
      label = `Indexed ${p.migrated} existing rows. Scanning sources…`;
      break;
    case "scanning":
      label = firstRun
        ? `Indexing your AI history… ${p.scanned.toLocaleString()} events processed · ${p.inserted.toLocaleString()} imported`
        : `Scanning… ${p.scanned.toLocaleString()} events processed · ${p.inserted.toLocaleString()} new imported`;
      break;
    case "done":
      label = firstRun
        ? `Ready. Imported ${p.inserted.toLocaleString()} events from your AI history — explore the tabs above.`
        : `Backfill complete — imported ${p.inserted.toLocaleString()} new events from ${p.scanned.toLocaleString()} scanned (${p.hashes_migrated.toLocaleString()} legacy rows hashed).`;
      cls = "success";
      break;
    case "failed":
      label = `Backfill failed: ${p.error}`;
      cls = "error";
      break;
  }
  const showSpinner = p.phase === "started" || p.phase === "hashes_migrated" || p.phase === "scanning";
  return (
    <div className={`backfill-banner ${cls}`}>
      {showSpinner && <span className="bf-spinner" />}
      <span className="bf-msg">{label}</span>
      {(p.phase === "done" || p.phase === "failed") && (
        <button className="bf-dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}

/* ---------- shared components ---------- */

function RiskCard({ risk }: { risk: RiskSummary }) {
  const levelLabel = { low: "LOW", med: "ELEVATED", high: "HIGH" }[risk.level];
  const dash = 2 * Math.PI * 28;
  const progress = (risk.score / 100) * dash;
  return (
    <div className={`risk-card level-${risk.level}`}>
      <div className="risk-ring">
        <svg width="76" height="76" viewBox="0 0 76 76">
          <circle cx="38" cy="38" r="28" stroke="rgba(255,255,255,0.06)" strokeWidth="6" fill="none" />
          <circle
            cx="38" cy="38" r="28"
            stroke="currentColor" strokeWidth="6" fill="none"
            strokeLinecap="round"
            strokeDasharray={`${progress} ${dash}`}
            transform="rotate(-90 38 38)"
            style={{ transition: "stroke-dasharray 300ms ease" }}
          />
        </svg>
        <div className="risk-score-num">{risk.score}</div>
      </div>
      <div className="risk-meta">
        <div className="risk-level-label">{levelLabel}</div>
        <div className="risk-window">over last {risk.windowSize} events</div>
        {risk.findings.length === 0 ? (
          <div className="risk-clean">no risky activity detected</div>
        ) : (
          <div className="risk-findings">
            {risk.findings.slice(0, 3).map((f) => (
              <div key={f.tag} className={`finding tag-${f.tag}`}>
                <span className="finding-tag">{f.tag}</span>
                <span className="finding-count">{f.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="stat">
      <div className={`stat-value ${accent ?? ""}`}>{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function FilterGroup<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="filter-group">
      <span className="filter-label">{label}</span>
      {options.map((o) => (
        <button
          key={o.v}
          className={`chip ${value === o.v ? "active" : ""}`}
          onClick={() => onChange(o.v)}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function EventRow({ ev }: { ev: AgentEvent }) {
  const lvl = riskLevel(ev.risk_tags);
  const { label: kindLabel, detail, kindCls } = renderKind(ev.kind);
  const ts = new Date(ev.timestamp).toLocaleTimeString("en-GB", { hour12: false });
  const isUsage = ev.kind.type === "usage";
  const usageDetail = ev.usage ? formatUsageDetail(ev.usage) : "";
  const displayDetail = isUsage ? usageDetail : detail;
  return (
    <div className={`row risk-${lvl} ${isUsage ? "row-usage" : ""}`}>
      <span className="ts">{ts}</span>
      <span className={`agent agent-${ev.agent}`}>{ev.agent}</span>
      <span className={`kind ${kindCls}`}>{kindLabel}</span>
      <span className="detail" title={displayDetail}>{displayDetail}</span>
      <span className="cwd" title={ev.cwd ?? ""}>{shortenCwd(ev.cwd)}</span>
      <span className="risk">
        {ev.usage && !isUsage ? (
          <span className="cost-pill">{fmtUSD(ev.usage.cost_micros)}</span>
        ) : ev.risk_tags.length === 0 ? (
          <span className="dot dot-low">·</span>
        ) : (
          <>
            <span className={`dot dot-${lvl}`}>●</span>
            <span className="tags">{ev.risk_tags.join(",")}</span>
          </>
        )}
      </span>
    </div>
  );
}

function formatUsageDetail(u: import("./types").Usage): string {
  const parts: string[] = [];
  if (u.model) parts.push(u.model);
  parts.push(`↓ ${fmtTokens(u.input_tokens)}`);
  if (u.cache_read_tokens > 0) parts.push(`cache ${fmtTokens(u.cache_read_tokens)}`);
  if (u.cache_creation_tokens > 0) parts.push(`+cache ${fmtTokens(u.cache_creation_tokens)}`);
  parts.push(`↑ ${fmtTokens(u.output_tokens + u.reasoning_tokens)}`);
  parts.push(fmtUSD(u.cost_micros));
  return parts.join("  ");
}

function renderKind(k: EventKind): { label: string; detail: string; kindCls: string } {
  switch (k.type) {
    case "session_start":
      return { label: "session", detail: `start  model=${k.model ?? "?"}  v=${k.version ?? "?"}`, kindCls: "k-session" };
    case "user_prompt":
      return { label: "user", detail: oneLine(k.text), kindCls: "k-user" };
    case "assistant_thinking":
      return { label: "think", detail: "(thinking…)", kindCls: "k-think" };
    case "assistant_text":
      return { label: "reply", detail: oneLine(k.text), kindCls: "k-reply" };
    case "tool_use":
      return { label: k.name, detail: k.summary, kindCls: "k-tool" };
    case "tool_result":
      return { label: k.ok ? "ok" : "err", detail: oneLine(k.summary), kindCls: k.ok ? "k-ok" : "k-err" };
    case "system":
      return { label: "system", detail: oneLine(k.text), kindCls: "k-system" };
    case "usage":
      return { label: "usage", detail: "", kindCls: "k-usage" };
    case "other":
      return { label: k.tag, detail: "", kindCls: "k-system" };
  }
}

function oneLine(s: string): string {
  return s.replace(/\n/g, " ⏎ ").trim();
}

function shortenCwd(cwd: string | null): string {
  if (!cwd) return "—";
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

function formatRange(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const now = new Date();
  const sameDay = start.toDateString() === end.toDateString();
  const isToday = end.toDateString() === now.toDateString();
  const isYesterday =
    end.toDateString() === new Date(now.getTime() - 24 * 3600 * 1000).toDateString();

  const t = (d: Date) => d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const dayPart = isToday ? "today" : isYesterday ? "yesterday" : start.toLocaleDateString();

  if (sameDay) return `${dayPart} ${t(start)} → ${t(end)}`;
  return `${start.toLocaleDateString()} ${t(start)} → ${end.toLocaleDateString()} ${t(end)}`;
}

export default App;
