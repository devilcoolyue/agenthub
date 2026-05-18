import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  ModelCost,
  ModelUsage,
  PolicyItem,
  RiskSummary,
  SessionCategory,
  SessionSummary,
  SessionsFilter,
} from "./types";
import { riskLevel, computeRiskSummary, fmtTokens, fmtUSD } from "./types";
import {
  computeCostMicros,
  DEFAULT_PRICES,
  knownModelKeys,
  normalizeModelKey,
  priceFor,
  type ModelPrice,
} from "./pricing";
import { type Lang, type Translator, makeTranslator } from "./i18n";
import {
  type Liveness,
  type Thresholds,
  formatBytes,
  formatRange,
  livenessOf,
  shortenCwd,
} from "./utils";
import { useAnimatedNumber, useNow } from "./hooks";
import {
  formatUsageDetail,
  fullEventText,
  renderKind,
  renderMarkdownLite,
  shortModel,
} from "./eventRender";
import {
  type RetentionDays,
  type Settings,
  type SettingsContextValue,
  type TabKey,
  DEFAULT_SETTINGS,
  SettingsContext,
  loadSettings,
  saveSettings,
  useSettings,
} from "./settings";
import claudeIcon from "./assets/claude.svg";
import codexIcon from "./assets/codex.svg";
import "./App.css";

const MAX_EVENTS = 500;

type View =
  | { type: "activity" }
  | { type: "dashboard" }
  | { type: "sessions" }
  | { type: "session-detail"; sessionId: string }
  | { type: "cost" }
  | { type: "policy" }
  | { type: "settings" };

function App() {
  const [settings, setSettingsState] = useState<Settings>(() => loadSettings());
  const update = useCallback((patch: Partial<Settings>) => {
    setSettingsState((cur) => {
      const next = { ...cur, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);
  const reset = useCallback(() => {
    setSettingsState(DEFAULT_SETTINGS);
    saveSettings(DEFAULT_SETTINGS);
  }, []);
  const thresholds = useMemo<Thresholds>(
    () => ({
      liveMs: settings.liveSeconds * 1000,
      recentMs: settings.recentMinutes * 60_000,
    }),
    [settings.liveSeconds, settings.recentMinutes],
  );
  const t = useMemo(() => makeTranslator(settings.language), [settings.language]);
  const settingsCtx = useMemo<SettingsContextValue>(
    () => ({ settings, thresholds, update, reset, t }),
    [settings, thresholds, update, reset, t],
  );

  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [view, setView] = useState<View>(() => ({ type: settings.defaultTab }));
  const [backfill, setBackfill] = useState<BackfillProgress | null>(null);
  const [isFirstRun, setIsFirstRun] = useState(false);
  const [eventCount, setEventCount] = useState<number | null>(null);
  const [dbSize, setDbSize] = useState<number | null>(null);
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

  // Auto-backfill at launch in two cases:
  //  1) DB is empty — brand-new user, populate so they don't see a blank window.
  //  2) A migration set `pending_backfill` (e.g. v3 purged bad codex Usage rows)
  //     and needs the JSONL re-read with the fixed parser. Backend clears the
  //     flag when backfill completes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [count, pending] = await Promise.all([
          invoke<number>("get_event_count"),
          invoke<string | null>("get_pending_backfill"),
        ]);
        if (cancelled) return;
        setEventCount(count);
        if (count > 0 && !pending) return;
        setIsFirstRun(count === 0);
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

  // Refresh stored event count + db size whenever a backfill or cleanup completes.
  // Fetched independently so one failing (e.g. older Tauri build without the
  // command registered) doesn't leave the other stuck at null.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const count = await invoke<number>("get_event_count");
        if (!cancelled) setEventCount(count);
      } catch {
        /* ignore */
      }
    })();
    (async () => {
      try {
        const size = await invoke<number>("get_db_size");
        if (!cancelled) setDbSize(size);
      } catch {
        if (!cancelled) setDbSize(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  const purgeEvents = async (days: number) => {
    const res = await invoke<{ deleted: number; freed_bytes: number }>(
      "purge_events",
      { days },
    );
    setRefreshKey((k) => k + 1);
    return res;
  };

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

  // Per-session last-seen timestamp, derived from the rolling event window.
  // Used to drive the "live"/"recent"/"idle" visual state on session cards.
  const liveMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const ev of events) {
      const ts = Date.parse(ev.timestamp);
      if (Number.isNaN(ts)) continue;
      const prev = m.get(ev.session_id);
      if (prev === undefined || ts > prev) m.set(ev.session_id, ts);
    }
    return m;
  }, [events]);
  const now = useNow(1000);

  const appClass =
    `app density-${settings.density}` +
    (settings.reduceMotion ? " reduce-motion" : "");

  return (
    <SettingsContext.Provider value={settingsCtx}>
    <div className={appClass}>
      <header className={`header level-${risk.level}`}>
        <div className="header-left">
          <div className="brand">
            <span className="logo-dot" />
            <span className="brand-name">AgentHub</span>
            <span className="brand-tag">{t("brand.tag")}</span>
          </div>
          <div className="stats">
            <Stat label={t("stat.events")} value={stats.total} />
            <Stat label={t("stat.claude")} value={stats.byAgent["claude-code"] ?? 0} accent="cyan" />
            <Stat label={t("stat.codex")} value={stats.byAgent["codex"] ?? 0} accent="magenta" />
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

      {view.type === "activity" && (
        <ActivityView
          events={events}
          onOpenSession={(id) => setView({ type: "session-detail", sessionId: id })}
        />
      )}
      {view.type === "dashboard" && (
        <DashboardView
          events={events}
          now={now}
          onOpenSession={(id) => setView({ type: "session-detail", sessionId: id })}
        />
      )}
      {view.type === "sessions" && (
        <SessionsView
          key={`sessions-${refreshKey}`}
          onOpen={(id) => setView({ type: "session-detail", sessionId: id })}
          liveMap={liveMap}
          now={now}
        />
      )}
      {view.type === "session-detail" && (
        <SessionDetailView
          key={`detail-${view.sessionId}-${refreshKey}`}
          sessionId={view.sessionId}
          onBack={() => setView({ type: "sessions" })}
          liveTs={liveMap.get(view.sessionId)}
          now={now}
        />
      )}
      {view.type === "cost" && <CostView key={`cost-${refreshKey}`} />}
      {view.type === "policy" && <PolicyView />}
      {view.type === "settings" && (
        <SettingsView
          backfill={backfill}
          isBackfillRunning={isBackfillRunning}
          startBackfill={startBackfill}
          eventCount={eventCount}
          dbSize={dbSize}
          purgeEvents={purgeEvents}
        />
      )}
    </div>
    </SettingsContext.Provider>
  );
}

function Tabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const { t } = useSettings();
  const tab: TabKey | "settings" =
    view.type === "session-detail" ? "sessions" : view.type;
  return (
    <nav className="tabs">
      <button
        className={`tab ${tab === "activity" ? "active" : ""}`}
        onClick={() => onView({ type: "activity" })}
      >
        {t("tab.activity")}
      </button>
      <button
        className={`tab ${tab === "dashboard" ? "active" : ""}`}
        onClick={() => onView({ type: "dashboard" })}
      >
        {t("tab.dashboard")}
      </button>
      <button
        className={`tab ${tab === "sessions" ? "active" : ""}`}
        onClick={() => onView({ type: "sessions" })}
      >
        {t("tab.sessions")}
      </button>
      <button
        className={`tab ${tab === "cost" ? "active" : ""}`}
        onClick={() => onView({ type: "cost" })}
      >
        {t("tab.cost")}
      </button>
      <button
        className={`tab ${tab === "policy" ? "active" : ""}`}
        onClick={() => onView({ type: "policy" })}
      >
        {t("tab.policy")}
      </button>
      <span className="tabs-spacer" />
      <button
        className={`tab tab-settings ${tab === "settings" ? "active" : ""}`}
        onClick={() => onView({ type: "settings" })}
        title={t("tab.settings")}
        aria-label={t("tab.settings")}
      >
        <span className="tab-gear" aria-hidden>⚙</span>
        {t("tab.settings")}
      </button>
    </nav>
  );
}

/* ---------- Activity view ---------- */

function ActivityView({
  events,
  onOpenSession,
}: {
  events: AgentEvent[];
  onOpenSession: (sessionId: string) => void;
}) {
  const { settings, t } = useSettings();
  const [filterAgent, setFilterAgent] = useState<Agent | "all">("all");
  const [filterRisk, setFilterRisk] = useState<"all" | "med+" | "high">("all");
  const [filterTool, setFilterTool] = useState<string>("all");
  const [showUsage, setShowUsage] = useState(settings.defaultShowUsage);
  const [autoScroll, setAutoScroll] = useState(settings.defaultAutoScroll);
  // Which row is currently inline-expanded. Single-open at a time keeps the
  // feed scannable; key is stable across re-renders since it's derived from
  // event identity, not array index.
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // Tool dropdown options: every tool_use name in the window, sorted by
  // frequency. Keep the active selection visible even if it's no longer in
  // the window.
  const toolNames = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ev of events) {
      if (ev.kind.type === "tool_use") {
        counts.set(ev.kind.name, (counts.get(ev.kind.name) ?? 0) + 1);
      }
    }
    const sorted = Array.from(counts.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([name]) => name);
    if (filterTool !== "all" && !sorted.includes(filterTool)) sorted.push(filterTool);
    return sorted;
  }, [events, filterTool]);

  // Walk events oldest→newest, threading the active model per session so
  // each row can show "what model was answering at the time" — codex can
  // switch models mid-session, so a session-wide constant won't do.
  const filtered = useMemo(() => {
    const running = new Map<string, string>();
    const out: { ev: AgentEvent; model: string | null }[] = [];
    for (const ev of events) {
      if (ev.usage?.model) {
        running.set(ev.session_id, ev.usage.model);
      } else if (
        ev.kind.type === "session_start" &&
        ev.kind.model &&
        !running.has(ev.session_id)
      ) {
        running.set(ev.session_id, ev.kind.model);
      }
      if (filterAgent !== "all" && ev.agent !== filterAgent) continue;
      if (filterRisk === "high" && riskLevel(ev.risk_tags) !== "high") continue;
      if (filterRisk === "med+" && riskLevel(ev.risk_tags) === "low") continue;
      if (!showUsage && ev.kind.type === "usage") continue;
      if (filterTool !== "all") {
        if (ev.kind.type !== "tool_use" || ev.kind.name !== filterTool) continue;
      }
      out.push({ ev, model: running.get(ev.session_id) ?? null });
    }
    return out;
  }, [events, filterAgent, filterRisk, filterTool, showUsage]);

  return (
    <>
      <div className="toolbar">
        <Segmented
          value={filterAgent}
          options={[
            { v: "all", l: t("common.all") },
            { v: "claude-code", l: "claude-code" },
            { v: "codex", l: "codex" },
          ]}
          onChange={(v) => setFilterAgent(v as Agent | "all")}
          ariaLabel={t("activity.filter.agent")}
        />
        <Segmented
          value={filterRisk}
          options={[
            { v: "all", l: t("common.all") },
            { v: "med+", l: t("activity.filter.medPlus") },
            { v: "high", l: t("activity.filter.high") },
          ]}
          onChange={(v) => setFilterRisk(v as "all" | "med+" | "high")}
          ariaLabel={t("activity.filter.risk")}
        />
        <div className="tool-select">
          <span className="select-label">{t("activity.tool")}</span>
          <select
            value={filterTool}
            onChange={(e) => setFilterTool(e.target.value)}
            aria-label={t("activity.filter.tool")}
          >
            <option value="all">{t("common.all")}</option>
            {toolNames.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-right">
          <ToggleSwitch checked={showUsage} label={t("activity.usage")} onChange={setShowUsage} />
          <ToggleSwitch checked={autoScroll} label={t("activity.autoScroll")} onChange={setAutoScroll} />
        </div>
      </div>

      <div className="event-list" ref={listRef}>
        {filtered.length === 0 && (
          <div className="empty">
            {t("activity.empty")}
          </div>
        )}
        {filtered.map(({ ev, model }, i) => {
          const expandKey = `${ev.session_id}|${ev.timestamp}|${ev.kind.type}|${i}`;
          return (
            <EventRow
              key={i}
              ev={ev}
              model={model}
              onOpenSession={onOpenSession}
              expanded={expandedKey === expandKey}
              onToggleExpand={() =>
                setExpandedKey((prev) => (prev === expandKey ? null : expandKey))
              }
            />
          );
        })}
      </div>
    </>
  );
}

/* ---------- Dashboard view ---------- */

interface RecentTool {
  name: string;
  ts: number;
  risky: boolean;
  count: number;
}

interface PendingTool {
  name: string;
  summary: string;
  startedAt: number;
  stalled: boolean;
}

interface PodState {
  sessionId: string;
  agent: Agent;
  cwd: string | null;
  lastTs: number;
  liveness: "live" | "recent";
  pending: PendingTool | null;
  recentTools: RecentTool[];
}

interface AgentVitals {
  liveCount: number;
  eventsLast5s: number;
}

interface HomeStat {
  cwd: string | null;     // null means "(no cwd)"
  sessionCount: number;   // active (live+recent) sessions in this home
  lastTs: number;
}

interface ToolStat {
  name: string;
  count: number;          // total uses across the event window
  risky: boolean;         // any use carried a risk tag
  lastTs: number;
  byClaude: boolean;      // any invocation came from claude-code
  byCodex: boolean;       // any invocation came from codex
}

type ToolOwner = "claude" | "codex" | "shared";

function ownerOf(t: ToolStat): ToolOwner {
  if (t.byClaude && t.byCodex) return "shared";
  if (t.byCodex) return "codex";
  return "claude";
}

interface DashboardData {
  pods: PodState[];
  hiddenIdleCount: number;
  perAgent: Record<Agent, AgentVitals>;
  homes: HomeStat[];
  hiddenHomes: number;
  tools: ToolStat[];
  hiddenTools: number;
}

const MAX_HOMES = 10;
const MAX_TOOLS = 12;

// Pure derivation from the rolling event window. Walk oldest → newest,
// accumulating per-session state, then filter+sort.
function derivePods(
  events: AgentEvent[],
  now: number,
  thresholds: Thresholds,
): DashboardData {
  type Acc = {
    agent: Agent;
    cwd: string | null;
    lastTs: number;
    pending: { name: string; summary: string; startedAt: number } | null;
    recentTools: RecentTool[];
  };
  const m = new Map<string, Acc>();
  const perAgent: Record<Agent, AgentVitals> = {
    "claude-code": { liveCount: 0, eventsLast5s: 0 },
    codex: { liveCount: 0, eventsLast5s: 0 },
  };
  const toolMap = new Map<string, ToolStat>();

  for (const ev of events) {
    const ts = Date.parse(ev.timestamp);
    if (Number.isNaN(ts)) continue;
    if (now - ts < 5000) perAgent[ev.agent].eventsLast5s++;

    let acc = m.get(ev.session_id);
    if (!acc) {
      acc = { agent: ev.agent, cwd: ev.cwd, lastTs: ts, pending: null, recentTools: [] };
      m.set(ev.session_id, acc);
    }
    acc.agent = ev.agent;
    if (ev.cwd) acc.cwd = ev.cwd;
    if (ts > acc.lastTs) acc.lastTs = ts;

    if (ev.kind.type === "tool_use") {
      const name = ev.kind.name;
      const risky = ev.risk_tags.length > 0;
      const top = acc.recentTools[acc.recentTools.length - 1];
      if (top && top.name === name) {
        // Coalesce back-to-back identical calls so a tight loop doesn't
        // drown the ticker.
        top.count++;
        top.ts = ts;
        top.risky = top.risky || risky;
      } else {
        acc.recentTools.push({ name, ts, risky, count: 1 });
        if (acc.recentTools.length > 8) acc.recentTools.shift();
      }
      acc.pending = { name, summary: ev.kind.summary, startedAt: ts };

      const ts2 =
        toolMap.get(name) ??
        { name, count: 0, risky: false, lastTs: 0, byClaude: false, byCodex: false };
      ts2.count++;
      ts2.risky = ts2.risky || risky;
      ts2.lastTs = Math.max(ts2.lastTs, ts);
      if (ev.agent === "claude-code") ts2.byClaude = true;
      else if (ev.agent === "codex") ts2.byCodex = true;
      toolMap.set(name, ts2);
    } else if (ev.kind.type === "tool_result") {
      acc.pending = null;
    }
  }

  const pods: PodState[] = [];
  const homeMap = new Map<string, HomeStat>();
  for (const [sid, acc] of m) {
    const live = livenessOf(acc.lastTs, now, thresholds);
    if (live === "idle") continue;
    if (live === "live") perAgent[acc.agent].liveCount++;
    pods.push({
      sessionId: sid,
      agent: acc.agent,
      cwd: acc.cwd,
      lastTs: acc.lastTs,
      liveness: live,
      pending: acc.pending
        ? { ...acc.pending, stalled: now - acc.pending.startedAt > 30_000 }
        : null,
      recentTools: acc.recentTools,
    });

    const homeKey = acc.cwd ?? "__none__";
    const hs =
      homeMap.get(homeKey) ?? { cwd: acc.cwd, sessionCount: 0, lastTs: 0 };
    hs.sessionCount++;
    hs.lastTs = Math.max(hs.lastTs, acc.lastTs);
    homeMap.set(homeKey, hs);
  }
  pods.sort((a, b) => {
    if (a.liveness !== b.liveness) return a.liveness === "live" ? -1 : 1;
    return b.lastTs - a.lastTs;
  });

  const allHomes = Array.from(homeMap.values()).sort(
    (a, b) => b.lastTs - a.lastTs,
  );
  const homes = allHomes.slice(0, MAX_HOMES);
  const allTools = Array.from(toolMap.values()).sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    return b.lastTs - a.lastTs;
  });
  const tools = allTools.slice(0, MAX_TOOLS);

  return {
    pods,
    perAgent,
    hiddenIdleCount: m.size - pods.length,
    homes,
    hiddenHomes: allHomes.length - homes.length,
    tools,
    hiddenTools: allTools.length - tools.length,
  };
}

const AGENT_ICON: Record<Agent, string> = {
  "claude-code": claudeIcon,
  codex: codexIcon,
};

// Stage geometry — keep in sync with --row-h / --sprite-r in App.css.
const ROW_H = 36;
const SPRITE_R = 14;
// Minimum on-screen "trip" duration. Many tool calls return in < 1 frame
// (the JSONL tailer sees tool_use and tool_result in the same poll), so
// without this floor the sprite never gets a chance to actually walk to
// the bench. While the latest tool_use is within this window, we pin the
// sprite at that bench regardless of whether the result has landed.
const TOOL_DISPLAY_MS = 2800;
// How long a bench stays visibly "active" (scaled up, brighter) after its
// last call. Covers walk-in (1.8s) + parked (1s) + walk-back (1.8s), so
// the bench only shrinks once the sprite has actually returned home.
const BENCH_ACTIVE_MS = 4800;

type SpriteMood = "idle" | "drowsy" | "working" | "stalled";

interface StageSprite {
  sessionId: string;
  agent: Agent;
  x: number;
  y: number;
  mood: SpriteMood;
  label?: string;
  cwd: string | null;
}

function DashboardView({
  events,
  now,
  onOpenSession,
}: {
  events: AgentEvent[];
  now: number;
  onOpenSession: (sessionId: string) => void;
}) {
  const { thresholds, t } = useSettings();
  const data = useMemo(
    () => derivePods(events, now, thresholds),
    [events, now, thresholds],
  );

  return (
    <div className="dashboard-view">
      <div className="dash-strip">
        {(Object.keys(data.perAgent) as Agent[]).map((agent) => {
          const v = data.perAgent[agent];
          return (
            <div key={agent} className={`dash-agent agent-${agent}`}>
              <span className={`agent-badge agent-${agent}`}>
                <img src={AGENT_ICON[agent]} alt={agent} draggable={false} />
              </span>
              <span className="dash-agent-name">{agent}</span>
              <span className="dash-agent-sep">·</span>
              <span className="dash-agent-live">
                <span className="sc-live-dot" />
                {v.liveCount} {t("dash.liveSuffix")}
              </span>
              <span className="dash-agent-sep">·</span>
              <span className="dash-agent-rate">
                {(v.eventsLast5s / 5).toFixed(1)} {t("dash.evPerSec")}
              </span>
            </div>
          );
        })}
      </div>

      {data.pods.length === 0 ? (
        <div className="dash-empty">
          <div className="dash-empty-title">{t("dash.empty.title")}</div>
          <div className="dash-empty-sub">{t("dash.empty.sub")}</div>
        </div>
      ) : (
        <StageView data={data} now={now} onOpenSession={onOpenSession} />
      )}

      {data.pods.length > 0 && (
        <details className="dash-details">
          <summary>{t("dash.details")}</summary>
          <div className="dash-grid">
            {data.pods.map((p) => (
              <SessionPod
                key={p.sessionId}
                p={p}
                now={now}
                onClick={() => onOpenSession(p.sessionId)}
              />
            ))}
          </div>
        </details>
      )}

      {data.hiddenIdleCount > 0 && (
        <div className="dash-hidden">
          + {t("dash.hidden", {
            n: data.hiddenIdleCount,
            s: data.hiddenIdleCount === 1 ? "" : "s",
          })}
        </div>
      )}
    </div>
  );
}

/* ---------- Stage (workshop map) ---------- */

function StageView({
  data,
  now,
  onOpenSession,
}: {
  data: DashboardData;
  now: number;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useSettings();
  const fieldRef = useRef<HTMLDivElement>(null);
  const [fieldW, setFieldW] = useState(0);

  useEffect(() => {
    const node = fieldRef.current;
    if (!node) return;
    const update = () => setFieldW(node.clientWidth);
    update();
    const obs = new ResizeObserver(update);
    obs.observe(node);
    return () => obs.disconnect();
  }, []);

  const homeIdx = useMemo(() => {
    const m = new Map<string, number>();
    data.homes.forEach((h, i) => m.set(h.cwd ?? "__none__", i));
    return m;
  }, [data.homes]);

  const toolIdx = useMemo(() => {
    const m = new Map<string, number>();
    data.tools.forEach((t, i) => m.set(t.name, i));
    return m;
  }, [data.tools]);

  // Compute target (x, y) for each sprite. Off-stage homes are hidden.
  const sprites: StageSprite[] = [];
  let offStageCount = 0;
  for (const pod of data.pods) {
    const homeKey = pod.cwd ?? "__none__";
    const hIdx = homeIdx.get(homeKey);
    if (hIdx === undefined) {
      offStageCount++;
      continue;
    }
    const homeY = hIdx * ROW_H + ROW_H / 2;

    // Decide which tool, if any, the sprite should be visiting right now.
    // Priority: an unresolved pending call wins; otherwise fall back to
    // the most recent tool_use within the display window so even tools
    // that returned instantly still get a visible round-trip.
    const lastTool =
      pod.recentTools.length > 0
        ? pod.recentTools[pod.recentTools.length - 1]
        : null;
    let showingTool: string | null = null;
    let stalled = false;
    if (pod.pending) {
      showingTool = pod.pending.name;
      stalled = pod.pending.stalled;
    } else if (lastTool && now - lastTool.ts < TOOL_DISPLAY_MS) {
      showingTool = lastTool.name;
    }

    let x: number;
    let y: number;
    let mood: SpriteMood;
    let label: string | undefined;

    if (showingTool) {
      const tIdx = toolIdx.get(showingTool);
      if (tIdx !== undefined && fieldW > 0) {
        x = fieldW - SPRITE_R - 8;
        y = tIdx * ROW_H + ROW_H / 2;
      } else {
        // Tool not visible — stay at home but keep the label so the user
        // still sees what was called.
        x = SPRITE_R + 8;
        y = homeY;
      }
      mood = stalled ? "stalled" : "working";
      label = showingTool;
    } else {
      x = SPRITE_R + 8;
      y = homeY;
      mood = pod.liveness === "live" ? "idle" : "drowsy";
    }

    sprites.push({
      sessionId: pod.sessionId,
      agent: pod.agent,
      x,
      y,
      mood,
      label,
      cwd: pod.cwd,
    });
  }

  const homesHeight = Math.max(data.homes.length, 1) * ROW_H;
  const toolsHeight = Math.max(data.tools.length, 1) * ROW_H;

  return (
    <div className="stage-grid">
      <div className="stage-col col-homes">
        <div className="rail-title">{t("dash.col.homes")}</div>
        <div className="rail-rows" style={{ height: homesHeight }}>
          {data.homes.map((h) => (
            <HomeRow key={h.cwd ?? "__none__"} h={h} />
          ))}
        </div>
        {data.hiddenHomes > 0 && (
          <div className="rail-overflow">{t("dash.more", { n: data.hiddenHomes })}</div>
        )}
        {offStageCount > 0 && (
          <div className="rail-overflow dim">
            {t("dash.offstage", { n: offStageCount, s: offStageCount === 1 ? "" : "s" })}
          </div>
        )}
      </div>

      <div className="stage-col col-field">
        <div className="rail-title">{t("dash.col.field")}</div>
        <div
          className="field"
          ref={fieldRef}
          style={{ height: Math.max(homesHeight, toolsHeight) }}
        >
          {sprites.map((s) => (
            <Sprite
              key={s.sessionId}
              s={s}
              onClick={() => onOpenSession(s.sessionId)}
            />
          ))}
        </div>
      </div>

      <div className="stage-col col-tools">
        <div className="rail-title">{t("dash.col.tools")}</div>
        <div className="rail-rows" style={{ height: toolsHeight }}>
          {data.tools.map((tool) => (
            <ToolRow
              key={tool.name}
              t={tool}
              active={now - tool.lastTs < BENCH_ACTIVE_MS}
            />
          ))}
        </div>
        {data.hiddenTools > 0 && (
          <div className="rail-overflow">{t("dash.more", { n: data.hiddenTools })}</div>
        )}
      </div>
    </div>
  );
}

function HomeRow({ h }: { h: HomeStat }) {
  const { t } = useSettings();
  const nocwd = t("dash.nocwd");
  return (
    <div className="home-row" title={h.cwd ?? nocwd}>
      <span className="home-icon">▣</span>
      <span className="home-label">
        {h.cwd ? cwdLabel(h.cwd) : nocwd}
      </span>
      <span className="home-count" title={`${h.sessionCount} active`}>
        {h.sessionCount}
      </span>
    </div>
  );
}

function ToolRow({ t, active }: { t: ToolStat; active: boolean }) {
  const owner = ownerOf(t);
  // `.active` is data-driven and persists for the entire round-trip
  // (driven by App's 1s `now` tick + BENCH_ACTIVE_MS check). `.reacting`
  // layers a brief flash on top each individual call so the bench
  // visibly "twitches" on every new tool_use, even while already big.
  const prevCount = useRef(t.count);
  const [reacting, setReacting] = useState(false);
  useEffect(() => {
    if (t.count === prevCount.current) return;
    prevCount.current = t.count;
    setReacting(false);
    const raf = requestAnimationFrame(() => setReacting(true));
    const off = window.setTimeout(() => setReacting(false), 700);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(off);
    };
  }, [t.count]);

  return (
    <div
      className={`tool-row ${t.risky ? "risky" : ""} ${active ? "active" : ""} ${reacting ? "reacting" : ""}`}
      data-owner={owner}
      title={`${t.name} · used by ${owner === "shared" ? "claude-code + codex" : owner === "codex" ? "codex" : "claude-code"}`}
    >
      <span className="tool-row-flash" aria-hidden />
      <span className="tool-vendor">
        {t.byClaude && (
          <span className="vendor-dot vendor-claude">
            <img src={claudeIcon} alt="claude-code" draggable={false} />
          </span>
        )}
        {t.byCodex && (
          <span className="vendor-dot vendor-codex">
            <img src={codexIcon} alt="codex" draggable={false} />
          </span>
        )}
      </span>
      <span className="tool-name">{t.name}</span>
      <span key={`c-${t.count}`} className="tool-count">
        {t.count}
      </span>
    </div>
  );
}

function Sprite({ s, onClick }: { s: StageSprite; onClick: () => void }) {
  // The outer wrapper handles position (transform: translate) with a CSS
  // transition. The inner body handles bob/wobble via its own keyframes,
  // so the two motions compose without fighting.
  const showBubble = (s.mood === "working" || s.mood === "stalled") && !!s.label;
  return (
    <div
      className={`sprite agent-${s.agent} mood-${s.mood}`}
      style={{ transform: `translate(${s.x - SPRITE_R}px, ${s.y - SPRITE_R}px)` }}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={`${s.sessionId.slice(0, 8)} · ${s.cwd ?? "(no cwd)"}${
        s.label ? ` · calling ${s.label}` : ""
      }`}
      role="button"
    >
      {showBubble && (
        <div className={`sprite-bubble ${s.mood === "stalled" ? "stalled" : ""}`}>
          <span className="bubble-arrow">→</span>
          <span className="bubble-name">{s.label}</span>
          {s.mood === "stalled" && <span className="bubble-tail">…stalled</span>}
        </div>
      )}
      <div className="sprite-body">
        <span className="sprite-eye sprite-eye-l" />
        <span className="sprite-eye sprite-eye-r" />
      </div>
      <div className="sprite-tag">{s.sessionId.slice(0, 6)}</div>
    </div>
  );
}

function SessionPod({
  p,
  now,
  onClick,
}: {
  p: PodState;
  now: number;
  onClick: () => void;
}) {
  const { t } = useSettings();
  // Drive the tool-flash by remounting the keyed flash element on each
  // new tool event. The flash class itself is short-lived (CSS handles it).
  const lastToolKey =
    p.recentTools.length > 0
      ? `${p.recentTools[p.recentTools.length - 1].name}-${p.recentTools[p.recentTools.length - 1].ts}-${p.recentTools[p.recentTools.length - 1].count}`
      : "none";

  const ageSec = Math.max(0, Math.floor((now - p.lastTs) / 1000));
  const lastToolName =
    p.recentTools.length > 0
      ? p.recentTools[p.recentTools.length - 1].name
      : null;

  return (
    <button
      className={`session-pod ${p.liveness === "live" ? "is-live" : "is-recent"}`}
      data-live={p.liveness}
      onClick={onClick}
    >
      <span key={lastToolKey} className="pod-flash" aria-hidden />

      <div className="pod-head">
        <span className={`agent-badge agent-${p.agent}`}>
          <img src={AGENT_ICON[p.agent]} alt={p.agent} draggable={false} />
        </span>
        <span className="pod-sid">{p.sessionId.slice(0, 8)}</span>
        <span className="pod-spacer" />
        {p.liveness === "live" ? (
          <span className="sc-live-pill" title="active now">
            <span className="sc-live-dot" /> LIVE
          </span>
        ) : (
          <span className="pod-age" title={new Date(p.lastTs).toLocaleString()}>
            {ageSec < 60 ? `${ageSec}s ago` : `${Math.floor(ageSec / 60)}m ago`}
          </span>
        )}
      </div>

      <div className="pod-cwd" title={p.cwd ?? ""}>
        {shortenCwd(p.cwd)}
      </div>

      <div className="pod-now">
        {p.pending ? (
          <>
            <span className={`pod-now-arrow ${p.pending.stalled ? "stalled" : ""}`}>▸</span>
            <span className="pod-now-name">{p.pending.name}</span>
            <span className="pod-now-summary" title={p.pending.summary}>
              {p.pending.summary ||
                (p.pending.stalled ? t("dash.stalled") : t("dash.running"))}
            </span>
            {!p.pending.stalled && <span className="pod-spinner" />}
          </>
        ) : (
          <span className="pod-now-idle">
            {lastToolName
              ? t("dash.lastTool", { name: lastToolName })
              : t("dash.noTools")}
          </span>
        )}
      </div>

      <div className="pod-ticker">
        {p.recentTools.map((tool, i, arr) => {
          const fromNewest = arr.length - 1 - i;
          return (
            <span
              key={`${tool.name}-${tool.ts}`}
              className={`pod-chip age-${Math.min(fromNewest, 4)} ${tool.risky ? "risky" : ""}`}
              title={`${tool.name}${tool.count > 1 ? ` ×${tool.count}` : ""}`}
            >
              {tool.name}
              {tool.count > 1 && <span className="pod-chip-count">×{tool.count}</span>}
            </span>
          );
        })}
      </div>
    </button>
  );
}

/* ---------- Sessions list view ---------- */

type CategorySelection =
  | { kind: "all" }
  | { kind: "high-risk" }
  | { kind: "cwd"; cwd: string | null };

const PAGE_SIZE = 20;

function SessionsView({
  onOpen,
  liveMap,
  now,
}: {
  onOpen: (sessionId: string) => void;
  liveMap: Map<string, number>;
  now: number;
}) {
  const { thresholds, t } = useSettings();
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

  if (categories === null)
    return <div className="empty">{t("sessions.loading")}</div>;

  // Count sessions that are currently live (event within the live window).
  let liveCount = 0;
  for (const ts of liveMap.values()) {
    if (now - ts < thresholds.liveMs) liveCount++;
  }

  return (
    <div className="sessions-layout">
      <aside className="sessions-sidebar">
        <SidebarItem
          label={t("sessions.all")}
          count={categories.reduce((a, c) => a + c.session_count, 0)}
          liveCount={liveCount}
          selected={selected.kind === "all"}
          onClick={() => setSelected({ kind: "all" })}
        />
        {(() => {
          const totalHigh = categories.reduce((a, c) => a + c.high_risk_session_count, 0);
          if (totalHigh === 0) return null;
          return (
            <SidebarItem
              label={t("sessions.highRisk")}
              count={totalHigh}
              danger
              selected={selected.kind === "high-risk"}
              onClick={() => setSelected({ kind: "high-risk" })}
            />
          );
        })()}
        <div className="sidebar-section-label">{t("sessions.projects")}</div>
        <div className="sidebar-projects">
          {categories.map((c) => (
            <SidebarItem
              key={c.cwd ?? "__none__"}
              label={cwdLabel(c.cwd, t)}
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
            placeholder={t("sessions.search")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          {searchInput && (
            <button className="search-clear" onClick={() => setSearchInput("")}>
              ×
            </button>
          )}
        </div>
        {(() => {
          // Trigram FTS can only match queries of 3+ codepoints; 1–2 chars
          // silently fall back to LIKE-on-path/id, which would mislead the
          // user into thinking content search is broken.
          const n = [...searchInput.trim()].length;
          return n > 0 && n < 3 ? (
            <div className="sessions-search-hint">{t("sessions.searchHint")}</div>
          ) : null;
        })()}

        <div className="sessions-list" ref={listScrollRef}>
          {sessions.length === 0 && !loading && (
            <div className="empty">{t("sessions.empty")}</div>
          )}
          {sessions.map((s) => (
            <SessionCard
              key={s.session_id}
              s={s}
              liveness={livenessOf(liveMap.get(s.session_id), now, thresholds)}
              onClick={() => onOpen(s.session_id)}
            />
          ))}
          <div ref={sentinelRef} className="sentinel">
            {loading
              ? t("sessions.loadingMore")
              : hasMore
              ? t("sessions.scrollMore")
              : sessions.length > 0
              ? t("sessions.end", { n: sessions.length })
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

function cwdLabel(cwd: string | null, translate?: Translator): string {
  if (!cwd) return translate ? translate("dash.nocwd") : "(no cwd)";
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
  liveCount,
  selected,
  danger,
  onClick,
}: {
  label: string;
  sublabel?: string;
  count: number;
  riskCount?: number;
  liveCount?: number;
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
        {liveCount && liveCount > 0 ? (
          <span className="sb-live" title={`${liveCount} live`}>
            <span className="sb-live-dot" />
            {liveCount}
          </span>
        ) : null}
        {riskCount && riskCount > 0 ? (
          <span className="sb-risk">{riskCount}</span>
        ) : null}
        <span className="sb-count">{count}</span>
      </span>
    </button>
  );
}

function SessionCard({
  s,
  liveness,
  onClick,
}: {
  s: SessionSummary;
  liveness: Liveness;
  onClick: () => void;
}) {
  const { t } = useSettings();
  const isHigh = s.high_risk_count > 0;
  const snippetParts = s.match_snippet ? parseSnippet(s.match_snippet) : null;
  return (
    <button
      className={`session-card ${isHigh ? "high" : ""}`}
      data-live={liveness}
      onClick={onClick}
    >
      <div className="sc-row1">
        <span className={`agent agent-${s.agent}`}>{s.agent}</span>
        <span className="sc-session-id">{s.session_id.slice(0, 8)}</span>
        {liveness === "live" && (
          <span className="sc-live-pill" title="active now">
            <span className="sc-live-dot" /> {t("common.live")}
          </span>
        )}
        {isHigh && (
          <span className="sc-risk-pill">
            {s.high_risk_count} {t("sessions.highRiskSuffix")}
          </span>
        )}
        {s.match_count != null && s.match_count > 0 && (
          <span className="sc-match-pill">
            {t(s.match_count === 1 ? "sessions.matches" : "sessions.matchesPlural", {
              n: s.match_count,
            })}
          </span>
        )}
      </div>
      <div className="sc-cwd" title={s.cwd ?? ""}>{shortenCwd(s.cwd) || "—"}</div>
      {snippetParts && (
        <div className="sc-snippet">
          {snippetParts.map((part, i) =>
            part.hit ? <mark key={i}>{part.text}</mark> : <span key={i}>{part.text}</span>,
          )}
        </div>
      )}
      <div className="sc-row3">
        <span>
          <span className="sc-num">{s.event_count}</span>
          <span className="sc-num-label"> {t("sessions.events")}</span>
        </span>
        <span>
          <span className="sc-num">{s.tool_count}</span>
          <span className="sc-num-label"> {t("sessions.tools")}</span>
        </span>
        <span className="sc-when" title={`${s.start_ts} → ${s.end_ts}`}>
          {formatRange(s.start_ts, s.end_ts, t)}
        </span>
      </div>
    </button>
  );
}

/** Split an FTS5 snippet (with `<<…>>` markers) into highlighted/plain parts.
 *  Markers come from sqlite's snippet() call, so we don't have to worry about
 *  HTML in the text — we never dangerouslySetInnerHTML. */
function parseSnippet(snippet: string): { text: string; hit: boolean }[] {
  const out: { text: string; hit: boolean }[] = [];
  const re = /<<([\s\S]*?)>>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet))) {
    if (m.index > last) out.push({ text: snippet.slice(last, m.index), hit: false });
    out.push({ text: m[1], hit: true });
    last = m.index + m[0].length;
  }
  if (last < snippet.length) out.push({ text: snippet.slice(last), hit: false });
  return out;
}

/* ---------- Session detail view ---------- */

function SessionDetailView({
  sessionId,
  onBack,
  liveTs,
  now,
}: {
  sessionId: string;
  onBack: () => void;
  liveTs: number | undefined;
  now: number;
}) {
  const { settings, update, thresholds, t } = useSettings();
  const live = livenessOf(liveTs, now, thresholds);
  const [events, setEvents] = useState<AgentEvent[] | null>(null);
  const [usage, setUsage] = useState<ModelUsage[] | null>(null);
  const [resumeBusy, setResumeBusy] = useState(false);
  const [resumeMsg, setResumeMsg] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<{ id: string; name: string }[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const resumeRef = useRef<HTMLDivElement | null>(null);

  // Effective default: persisted choice if it's still installed; otherwise
  // fall back to the first detected terminal (iTerm when present, else Terminal).
  const effectiveDefault = useMemo(() => {
    const persisted = settings.defaultTerminal;
    if (persisted && terminals.some((tm) => tm.id === persisted)) {
      return terminals.find((tm) => tm.id === persisted)!;
    }
    return terminals[0] ?? null;
  }, [settings.defaultTerminal, terminals]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [list, u] = await Promise.all([
        invoke<AgentEvent[]>("get_session_events", { sessionId }),
        invoke<ModelUsage[]>("get_session_usage", { sessionId }),
      ]);
      if (cancelled) return;
      setEvents(list);
      setUsage(u);
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await invoke<{ id: string; name: string }[]>(
          "list_available_terminals",
        );
        if (!cancelled) setTerminals(list);
      } catch {
        if (!cancelled) setTerminals([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (!resumeRef.current) return;
      if (!resumeRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const meta = useMemo(() => {
    if (!events || events.length === 0) return null;
    const agent = events[0].agent;
    // Pin to the session's launch cwd (first non-null), mirroring how the
    // backend stores sessions.cwd. Using the latest event would drift to a
    // subprocess's directory whenever a tool `cd`s mid-session.
    let cwd: string | null = null;
    for (let i = 0; i < events.length; i++) {
      if (events[i].cwd) { cwd = events[i].cwd; break; }
    }
    const start = events[0].timestamp;
    const end = events[events.length - 1].timestamp;
    const high = events.filter((e) => riskLevel(e.risk_tags) === "high").length;
    return { agent, cwd, start, end, high };
  }, [events]);

  const launchIn = async (terminal: string) => {
    if (resumeBusy || !meta?.cwd) return;
    setMenuOpen(false);
    setResumeBusy(true);
    setResumeMsg(null);
    try {
      const proxy =
        settings.terminalProxyEnabled &&
        settings.terminalProxyAddress.trim().length > 0
          ? settings.terminalProxyAddress.trim()
          : null;
      const cmd =
        meta.agent === "codex"
          ? "resume_codex_session"
          : "resume_claude_session";
      await invoke(cmd, {
        sessionId,
        cwd: meta.cwd,
        terminal,
        proxy,
      });
      setResumeMsg(t("detail.resume.launched"));
      window.setTimeout(() => setResumeMsg(null), 3000);
    } catch (e) {
      setResumeMsg(t("detail.resume.failed", { error: String(e) }));
    } finally {
      setResumeBusy(false);
    }
  };
  const canResume =
    (meta?.agent === "claude-code" || meta?.agent === "codex") && !!meta?.cwd;
  const resumeLabel =
    meta?.agent === "codex" ? t("detail.resume.codex") : t("detail.resume");
  const resumeHint =
    meta?.agent === "codex"
      ? t("detail.resume.hint.codex")
      : t("detail.resume.hint");

  return (
    <>
      <div className="detail-header" data-live={live}>
        <button className="back-btn" onClick={onBack}>{t("detail.back")}</button>
        {live === "live" && (
          <span className="sc-live-pill" title="active now">
            <span className="sc-live-dot" /> {t("common.live")}
          </span>
        )}
        {meta && (
          <div className="detail-meta">
            <span className={`agent agent-${meta.agent}`}>{meta.agent}</span>
            <span className="meta-sep">·</span>
            <span className="detail-cwd" title={meta.cwd ?? ""}>{shortenCwd(meta.cwd)}</span>
            <span className="meta-sep">·</span>
            <span>{events!.length} {t("detail.eventsSuffix")}</span>
            {meta.high > 0 && (
              <>
                <span className="meta-sep">·</span>
                <span className="detail-high">{meta.high} {t("detail.highRiskSuffix")}</span>
              </>
            )}
            <span className="meta-sep">·</span>
            <span className="detail-when">{formatRange(meta.start, meta.end, t)}</span>
          </div>
        )}
        <div className="detail-header-right">
          {canResume && (
            <div className="detail-resume-wrap" ref={resumeRef}>
              <button
                className="detail-resume-btn detail-resume-btn-main"
                onClick={() =>
                  launchIn(effectiveDefault?.id ?? "terminal")
                }
                disabled={resumeBusy}
                title={
                  effectiveDefault
                    ? t("detail.resume.hintWith", {
                        name: effectiveDefault.name,
                        cwd: meta?.cwd ?? "",
                      })
                    : resumeHint
                }
              >
                {resumeBusy ? t("detail.resume.launching") : resumeLabel}
              </button>
              {terminals.length > 1 && (
                <button
                  type="button"
                  className="detail-resume-btn detail-resume-btn-caret"
                  onClick={() => {
                    if (resumeBusy) return;
                    setMenuOpen((v) => !v);
                  }}
                  disabled={resumeBusy}
                  title={t("detail.resume.menuHint")}
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                >
                  <span aria-hidden>▾</span>
                </button>
              )}
              {menuOpen && terminals.length > 1 && (
                <div className="detail-resume-menu" role="menu">
                  {terminals.map((tm) => {
                    const isDefault = effectiveDefault?.id === tm.id;
                    return (
                      <div key={tm.id} className="detail-resume-menu-row">
                        <button
                          className="detail-resume-menu-item"
                          role="menuitem"
                          onClick={() => launchIn(tm.id)}
                        >
                          <span className="detail-resume-menu-name">
                            {t("detail.resume.openIn", { name: tm.name })}
                          </span>
                          {isDefault && (
                            <span className="detail-resume-default-badge">
                              {t("detail.resume.default")}
                            </span>
                          )}
                        </button>
                        {!isDefault && (
                          <button
                            type="button"
                            className="detail-resume-set-default"
                            onClick={(e) => {
                              e.stopPropagation();
                              update({ defaultTerminal: tm.id });
                            }}
                            title={t("detail.resume.setDefault")}
                          >
                            {t("detail.resume.setDefault")}
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {resumeMsg && <span className="detail-resume-msg">{resumeMsg}</span>}
          <span className="detail-id">{sessionId}</span>
        </div>
      </div>
      {usage && usage.length > 0 && <UsageBreakdown rows={usage} />}
      <div className="event-list">
        {events === null && <div className="empty">{t("detail.loading")}</div>}
        {events && events.length === 0 && <div className="empty">{t("detail.empty")}</div>}
        {(() => {
          // Same per-session model thread as ActivityView so each event in
          // the detail view shows the model active at the time. Detail is
          // single-session, but codex can switch models mid-session.
          let active: string | null = null;
          return events?.map((ev, i) => {
            if (ev.usage?.model) active = ev.usage.model;
            else if (ev.kind.type === "session_start" && ev.kind.model && !active)
              active = ev.kind.model;
            return <EventRow key={i} ev={ev} model={active} />;
          });
        })()}
      </div>
    </>
  );
}

function UsageBreakdown({ rows }: { rows: ModelUsage[] }) {
  const { settings, t } = useSettings();
  const pricing = settings.customPricing;
  const rowsWithCost = useMemo(
    () => rows.map((r) => ({ row: r, cost: computeCostMicros(r, pricing) })),
    [rows, pricing],
  );
  const total = useMemo(() => {
    return rowsWithCost.reduce(
      (acc, { row, cost }) => ({
        input_tokens: acc.input_tokens + row.input_tokens,
        cache_creation_tokens: acc.cache_creation_tokens + row.cache_creation_tokens,
        cache_read_tokens: acc.cache_read_tokens + row.cache_read_tokens,
        output_tokens: acc.output_tokens + row.output_tokens,
        reasoning_tokens: acc.reasoning_tokens + row.reasoning_tokens,
        cost_micros: acc.cost_micros + cost,
      }),
      {
        input_tokens: 0,
        cache_creation_tokens: 0,
        cache_read_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        cost_micros: 0,
      },
    );
  }, [rowsWithCost]);
  const showReasoning = total.reasoning_tokens > 0;
  const showCacheCreate = total.cache_creation_tokens > 0;
  return (
    <div className="usage-breakdown">
      <div className="usage-breakdown-title">{t("detail.usage.title")}</div>
      <table className="usage-table">
        <thead>
          <tr>
            <th>{t("detail.usage.col.model")}</th>
            <th className="num">{t("detail.usage.col.input")}</th>
            {showCacheCreate && <th className="num">{t("detail.usage.col.cacheCreate")}</th>}
            <th className="num">{t("detail.usage.col.cacheRead")}</th>
            <th className="num">{t("detail.usage.col.output")}</th>
            {showReasoning && <th className="num">{t("detail.usage.col.reasoning")}</th>}
            <th className="num">{t("detail.usage.col.cost")}</th>
          </tr>
        </thead>
        <tbody>
          {rowsWithCost.map(({ row: r, cost }) => (
            <tr key={r.model}>
              <td>{r.model}</td>
              <td className="num">{fmtTokens(r.input_tokens)}</td>
              {showCacheCreate && <td className="num">{fmtTokens(r.cache_creation_tokens)}</td>}
              <td className="num">{fmtTokens(r.cache_read_tokens)}</td>
              <td className="num">{fmtTokens(r.output_tokens)}</td>
              {showReasoning && <td className="num">{fmtTokens(r.reasoning_tokens)}</td>}
              <td className="num">{fmtUSD(cost)}</td>
            </tr>
          ))}
          {rowsWithCost.length > 1 && (
            <tr className="usage-total">
              <td>{t("detail.usage.col.total")}</td>
              <td className="num">{fmtTokens(total.input_tokens)}</td>
              {showCacheCreate && <td className="num">{fmtTokens(total.cache_creation_tokens)}</td>}
              <td className="num">{fmtTokens(total.cache_read_tokens)}</td>
              <td className="num">{fmtTokens(total.output_tokens)}</td>
              {showReasoning && <td className="num">{fmtTokens(total.reasoning_tokens)}</td>}
              <td className="num">{fmtUSD(total.cost_micros)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Cost view ---------- */

function AnimatedUSD({
  micros,
  className,
}: {
  micros: number;
  className?: string;
}) {
  const v = useAnimatedNumber(micros);
  return <div className={className}>{fmtUSD(v)}</div>;
}

function CostView() {
  const { settings, t } = useSettings();
  const pricing = settings.customPricing;
  const [daily, setDaily] = useState<DailyCost[] | null>(null);
  const [models, setModels] = useState<ModelCost[] | null>(null);
  const [disabled, setDisabled] = useState<Set<Agent>>(() => new Set());
  const toggleAgent = useCallback((a: Agent) => {
    setDisabled((prev) => {
      const next = new Set(prev);
      if (next.has(a)) next.delete(a);
      else next.add(a);
      return next;
    });
  }, []);

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
    return <div className="empty">{t("cost.loading")}</div>;

  if (daily.length === 0)
    return <div className="empty">{t("cost.empty")}</div>;

  // Build daily totals (sum across agents) and 7-day window for the chart.
  // Cost is computed from raw tokens via the user's customPricing so it
  // tracks live price edits without re-running backfill.
  const todayLocal = new Date();
  const todayKey = ymdLocal(todayLocal);
  const yesterdayKey = ymdLocal(new Date(todayLocal.getTime() - 86400000));

  const byDay = new Map<string, { total: number; perAgent: Record<string, number> }>();
  for (const d of daily) {
    const slot = byDay.get(d.day) ?? { total: 0, perAgent: {} };
    const cost = computeCostMicros(d, pricing);
    slot.total += cost;
    slot.perAgent[d.agent] = (slot.perAgent[d.agent] ?? 0) + cost;
    byDay.set(d.day, slot);
  }

  const todayMicros = byDay.get(todayKey)?.total ?? 0;
  const yesterdayMicros = byDay.get(yesterdayKey)?.total ?? 0;
  const deltaPct =
    yesterdayMicros > 0
      ? ((todayMicros - yesterdayMicros) / yesterdayMicros) * 100
      : null;

  const todayByAgent = byDay.get(todayKey)?.perAgent ?? {};

  const sumVisible = (perAgent: Record<string, number>): number => {
    let s = 0;
    for (const [a, v] of Object.entries(perAgent)) {
      if (!disabled.has(a as Agent)) s += v;
    }
    return s;
  };

  const todayVisibleMicros = sumVisible(todayByAgent);

  // 7-day chart (oldest → newest)
  const chartDays: { day: string; perAgent: Record<string, number>; total: number }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(todayLocal.getTime() - i * 86400000);
    const key = ymdLocal(d);
    const slot = byDay.get(key) ?? { total: 0, perAgent: {} };
    chartDays.push({ day: key, perAgent: slot.perAgent, total: sumVisible(slot.perAgent) });
  }
  const chartMax = Math.max(...chartDays.map((d) => d.total), 1);

  const total30 = daily.reduce(
    (a, d) => (disabled.has(d.agent as Agent) ? a : a + computeCostMicros(d, pricing)),
    0,
  );

  return (
    <div className="cost-view">
      {/* Top: Today big card + 30-day total */}
      <div className="cost-top">
        <div className="cost-today">
          <div className="cost-today-label">{t("cost.today")}</div>
          <AnimatedUSD micros={todayVisibleMicros} className="cost-today-value" />
          {deltaPct !== null && (
            <div
              className={`cost-delta ${
                deltaPct > 0 ? "up" : deltaPct < 0 ? "down" : ""
              }`}
            >
              {deltaPct > 0 ? "▲" : deltaPct < 0 ? "▼" : "·"}{" "}
              {Math.abs(deltaPct).toFixed(0)}% {t("cost.vsYesterday")}
            </div>
          )}
          <div className="cost-today-breakdown">
            {Object.entries(todayByAgent).map(([a, v]) => {
              const agent = a as Agent;
              const isOff = disabled.has(agent);
              const icon = AGENT_ICON[agent];
              return (
                <button
                  key={a}
                  type="button"
                  className={`cost-line cost-line-toggle ${isOff ? "off" : ""}`}
                  onClick={() => toggleAgent(agent)}
                  aria-pressed={!isOff}
                >
                  <span className={`agent agent-${a}`}>
                    {icon && (
                      <img
                        src={icon}
                        alt=""
                        className="cost-agent-icon"
                        draggable={false}
                      />
                    )}
                    {a}
                  </span>
                  <span className="cost-line-val">{fmtUSD(v)}</span>
                </button>
              );
            })}
            {Object.keys(todayByAgent).length === 0 && (
              <div className="cost-line dim">{t("cost.noActivity")}</div>
            )}
          </div>
        </div>

        <div className="cost-30d">
          <div className="cost-today-label">{t("cost.last30")}</div>
          <AnimatedUSD micros={total30} className="cost-30d-value" />
          <div className="cost-30d-note">{t("cost.estimated")}</div>
        </div>
      </div>

      {/* 7-day bar chart */}
      <div className="cost-section">
        <div className="cost-section-title">{t("cost.last7")}</div>
        <div className="cost-chart">
          {chartDays.map((d) => {
            const claudeCost = disabled.has("claude-code")
              ? 0
              : d.perAgent["claude-code"] ?? 0;
            const codexCost = disabled.has("codex")
              ? 0
              : d.perAgent["codex"] ?? 0;
            const claudePct = (claudeCost / chartMax) * 100;
            const codexPct = (codexCost / chartMax) * 100;
            const dayDate = new Date(d.day + "T00:00:00");
            const dayLabel =
              d.day === todayKey
                ? t("cost.todayShort")
                : d.day === yesterdayKey
                ? t("cost.yest")
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
          {(["claude-code", "codex"] as Agent[]).map((agent) => {
            const isOff = disabled.has(agent);
            const icon = AGENT_ICON[agent];
            return (
              <button
                key={agent}
                type="button"
                className={`legend-item legend-toggle ${isOff ? "off" : ""}`}
                onClick={() => toggleAgent(agent)}
                aria-pressed={!isOff}
              >
                {icon && (
                  <img
                    src={icon}
                    alt=""
                    className="cost-agent-icon"
                    draggable={false}
                  />
                )}
                <span className={`legend-swatch swatch-${agent === "claude-code" ? "claude" : "codex"}`} />
                {agent}
              </button>
            );
          })}
        </div>
      </div>

      {/* By model */}
      <div className="cost-section">
        <div className="cost-section-title">{t("cost.byModel")}</div>
        <div className="model-table">
          <div className="model-row head">
            <div>{t("cost.col.model")}</div>
            <div>{t("cost.col.input")}</div>
            <div>{t("cost.col.cacheRead")}</div>
            <div>{t("cost.col.cacheCreate")}</div>
            <div>{t("cost.col.output")}</div>
            <div>{t("cost.col.cost")}</div>
          </div>
          {models.map((m) => (
            <div key={m.model} className="model-row">
              <div className="model-name">{m.model}</div>
              <div>{fmtTokens(m.input_tokens)}</div>
              <div className="dim">{fmtTokens(m.cache_read_tokens)}</div>
              <div className="dim">{fmtTokens(m.cache_creation_tokens)}</div>
              <div>{fmtTokens(m.output_tokens + m.reasoning_tokens)}</div>
              <div className="cost-cell">{fmtUSD(computeCostMicros(m, pricing))}</div>
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
  const { t } = useSettings();
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
    setConfirming({
      items: [item],
      label: t("policy.removeSingle", {
        category: t(`policy.catName.${item.category}`),
      }),
    });
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
        setSuccess(t("policy.removed1"));
      } else {
        const actions = batch.items.map((i) => i.remove_action);
        const result = await invoke<BatchResult>("remove_policy_items", { actions });
        if (result.failed.length > 0) {
          setError(
            t("policy.removedFailed", {
              n: result.removed,
              list: result.failed.join("\n"),
            }),
          );
        } else {
          setSuccess(t("policy.removedN", { n: result.removed }));
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
      setSuccess(t("policy.restored", { file: b.original_path.split("/").pop() ?? "" }));
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  if (policies === null) return <div className="empty">{t("policy.loading")}</div>;
  if (policies.length === 0)
    return <div className="empty">{t("policy.empty")}</div>;

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
            {t("policy.history")}
            <span className="history-count">{backups.length}</span>
            <span className="history-hint">{t("policy.history.hint")}</span>
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
                  {t("policy.history.restore")}
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
  const { t } = useSettings();
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
            <>
              {"\n"}
              {t("policy.modal.andMore", { n: batch.items.length - previewLimit })}
            </>
          )}
        </pre>
        <div className="modal-detail">
          {filesAffected.length === 1
            ? t("policy.modal.affectsOne", {
                file: filesAffected[0].replace(/^\/Users\/[^/]+/, "~"),
              })
            : t("policy.modal.affectsMany", { n: filesAffected.length })}
        </div>
        <div className="modal-note">{t("policy.modal.note")}</div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            {t("policy.modal.cancel")}
          </button>
          <button className="btn-danger" onClick={onConfirm} autoFocus>
            {t("policy.modal.remove", { n: batch.items.length })}
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
  const { t } = useSettings();
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
          {t(
            p.config_files.length === 1 ? "policy.configFile" : "policy.configFiles",
            { n: p.config_files.length },
          )}
        </span>
        {p.high_risk_count > 0 && (
          <span className="policy-risk-pill">
            {t("policy.flaggedPill", { n: p.high_risk_count })}
          </span>
        )}
      </div>

      {order.map((cat) => {
        const items = groups.get(cat);
        if (!items || items.length === 0) return null;
        const title = t(`policy.cat.${cat}`);
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
                {flagged > 0 && (
                  <span className="ps-flagged">
                    {" · "}
                    {t("policy.flaggedSep", { n: flagged })}
                  </span>
                )}
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
                      onBatch(
                        arr,
                        t("policy.removeBulkLabel", { n: arr.length, tag }),
                      )
                    }
                  >
                    {t("policy.removeBulkBtn", { n: arr.length })} <code>{tag}</code>
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

function PolicyRow({
  it,
  pending,
  onRemove,
}: {
  it: PolicyItem;
  pending: boolean; // any policy op is in-flight
  onRemove: () => void;
}) {
  const { t } = useSettings();
  const high = it.risk_tags.length > 0;
  return (
    <li className={`policy-item ${high ? "flagged" : ""}`}>
      <div className="pi-main">
        <div className="pi-label" title={it.label}>{it.label}</div>
        {it.detail && <div className="pi-detail">{it.detail}</div>}
        {it.risk_tags.length > 0 && (
          <div className="pi-tags">
            {it.risk_tags.map((tag) => (
              <span key={tag} className={`pi-tag tag-${tag}`}>
                {tag}
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
          {pending ? "…" : t("policy.remove")}
        </button>
      )}
    </li>
  );
}

/* ---------- Backfill banner ---------- */

/* ---------- Settings view ---------- */

/** Convert internal micros-per-MTok to a USD string for display. Up to 4
 *  decimal places (so $0.075 / $0.02 / $0.175 etc. round-trip cleanly), with
 *  trailing zeros stripped. */
function microsToUsdStr(m: number): string {
  if (!isFinite(m)) return "0";
  const v = m / 1_000_000;
  const fixed = v.toFixed(4);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function usdToMicros(s: string): number | null {
  const n = parseFloat(s);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000);
}

type Vendor = "anthropic" | "openai" | "other";

function vendorOf(model: string): Vendor {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3"))
    return "openai";
  return "other";
}

/** Shallow equality across the two-level shape `Record<string, Partial<ModelPrice>>`.
 *  Used to detect whether the draft has unsaved differences vs. settings. */
function pricingOverridesEqual(
  a: Record<string, Partial<ModelPrice>>,
  b: Record<string, Partial<ModelPrice>>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const fields: (keyof ModelPrice)[] = ["input", "cacheCreate", "cacheRead", "output"];
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv) return false;
    for (const f of fields) {
      if (av[f] !== bv[f]) return false;
    }
  }
  return true;
}

function PricingSection() {
  const { settings, update, t } = useSettings();
  const saved = settings.customPricing;
  const [draft, setDraft] = useState<Record<string, Partial<ModelPrice>>>(saved);
  // Sync if settings change externally (e.g. another window or a `reset()`).
  // The local draft becomes the source of truth as soon as the user edits.
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const [resetAllConfirming, setResetAllConfirming] = useState(false);
  const [vendorOpenOverride, setVendorOpenOverride] = useState<
    Partial<Record<Vendor, boolean>>
  >({});

  const isDirty = !pricingOverridesEqual(draft, saved);
  const hasDraftOverrides = Object.keys(draft).length > 0;

  const setField = (model: string, field: keyof ModelPrice, raw: string) => {
    const micros = usdToMicros(raw);
    if (micros === null) return;
    const cur = draft[model] ?? {};
    const defaultPrice = DEFAULT_PRICES[normalizeModelKey(model)];
    // If the new value equals the default AND there's a saved DEFAULT_PRICES
    // entry for this model, drop the override for that field. For custom
    // models (no default entry), always keep the explicit value.
    const next: Partial<ModelPrice> = { ...cur };
    if (defaultPrice && defaultPrice[field] === micros) {
      delete next[field];
    } else {
      next[field] = micros;
    }
    const nextDraft = { ...draft };
    // Custom models (not in DEFAULT_PRICES) keep their key even with empty {}
    // so the row stays visible. Known models with all-default values get
    // removed entirely.
    if (Object.keys(next).length === 0 && DEFAULT_PRICES[normalizeModelKey(model)]) {
      delete nextDraft[model];
    } else {
      nextDraft[model] = next;
    }
    setDraft(nextDraft);
  };

  const resetRow = (model: string) => {
    if (!draft[model]) return;
    const next = { ...draft };
    delete next[model];
    setDraft(next);
  };

  const save = () => {
    update({ customPricing: draft });
  };
  const discard = () => {
    setDraft(saved);
  };
  const resetAll = () => {
    if (!resetAllConfirming) {
      setResetAllConfirming(true);
      window.setTimeout(() => setResetAllConfirming(false), 4000);
      return;
    }
    setResetAllConfirming(false);
    setDraft({});
  };

  const addCustom = (name: string): { ok: true } | { ok: false; reasonKey: string } => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reasonKey: "set.pricing.addCustom.err.empty" };
    const norm = normalizeModelKey(trimmed);
    if (DEFAULT_PRICES[norm] || DEFAULT_PRICES[trimmed] || draft[trimmed] || draft[norm]) {
      return { ok: false, reasonKey: "set.pricing.addCustom.err.dup" };
    }
    // Empty override entry — `priceFor` falls back to FALLBACK_PRICE for
    // display, and the row appears under `knownModelKeys`. Edits add fields
    // to this entry; Remove deletes it.
    setDraft({ ...draft, [trimmed]: {} });
    // Force the vendor group containing this model open so the user sees the
    // new row immediately.
    setVendorOpenOverride((v) => ({ ...v, [vendorOf(trimmed)]: true }));
    return { ok: true };
  };

  const keys = useMemo(() => knownModelKeys(draft), [draft]);
  const grouped = useMemo(() => {
    const out: Record<Vendor, string[]> = { anthropic: [], openai: [], other: [] };
    for (const k of keys) out[vendorOf(k)].push(k);
    return out;
  }, [keys]);

  const sections: { vendor: Vendor; labelKey: string }[] = [
    { vendor: "anthropic", labelKey: "set.pricing.vendor.anthropic" },
    { vendor: "openai", labelKey: "set.pricing.vendor.openai" },
    { vendor: "other", labelKey: "set.pricing.vendor.other" },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div className="settings-section-title">{t("set.section.pricing")}</div>
        <div className="pricing-actions">
          {hasDraftOverrides && (
            <button
              type="button"
              className="pricing-reset-all"
              onClick={resetAll}
            >
              {resetAllConfirming
                ? t("set.pricing.resetAll.confirm")
                : t("set.pricing.resetAll")}
            </button>
          )}
          {isDirty && (
            <button
              type="button"
              className="pricing-discard"
              onClick={discard}
            >
              {t("set.pricing.discard")}
            </button>
          )}
          <button
            type="button"
            className={`pricing-save ${isDirty ? "active" : ""}`}
            onClick={save}
            disabled={!isDirty}
          >
            {t("set.pricing.save")}
          </button>
        </div>
      </div>
      <div className="settings-section-hint">{t("set.pricing.hint")}</div>
      {isDirty && (
        <div className="pricing-unsaved-banner">
          {t("set.pricing.unsavedBanner")}
        </div>
      )}
      <div className="pricing-groups">
        {sections.map(({ vendor, labelKey }) => {
          const models = grouped[vendor];
          if (models.length === 0) return null;
          const draftEditedCount = models.filter(
            (m) => (draft[normalizeModelKey(m)] ?? draft[m]) !== undefined,
          ).length;
          // Auto-expand if vendor has any draft entries (saved or unsaved), so
          // user lands on the relevant rows. Once user toggles manually, that
          // choice persists for the session via vendorOpenOverride.
          const open =
            vendorOpenOverride[vendor] ??
            (draftEditedCount > 0);
          return (
            <PricingVendorGroup
              key={vendor}
              label={t(labelKey)}
              models={models}
              countLabel={t("set.pricing.vendor.count", { models: String(models.length) })}
              editedLabel={
                draftEditedCount > 0
                  ? t("set.pricing.vendor.editedCount", { n: String(draftEditedCount) })
                  : null
              }
              open={open}
              onToggle={(o) =>
                setVendorOpenOverride((v) => ({ ...v, [vendor]: o }))
              }
              draft={draft}
              saved={saved}
              onChange={setField}
              onReset={resetRow}
            />
          );
        })}
      </div>
      <PricingAddCustomForm onAdd={addCustom} />
    </div>
  );
}

function PricingVendorGroup({
  label,
  models,
  countLabel,
  editedLabel,
  open,
  onToggle,
  draft,
  saved,
  onChange,
  onReset,
}: {
  label: string;
  models: string[];
  countLabel: string;
  editedLabel: string | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  draft: Record<string, Partial<ModelPrice>>;
  saved: Record<string, Partial<ModelPrice>>;
  onChange: (model: string, field: keyof ModelPrice, raw: string) => void;
  onReset: (model: string) => void;
}) {
  const { t } = useSettings();
  return (
    <details
      className="pricing-group"
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary className="pricing-group-summary">
        <span className="pricing-group-caret" aria-hidden>▸</span>
        <span className="pricing-group-label">{label}</span>
        <span className="pricing-group-count">{countLabel}</span>
        {editedLabel && <span className="pricing-group-edited">{editedLabel}</span>}
      </summary>
      <div className="pricing-table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>{t("set.pricing.col.model")}</th>
              <th className="num">{t("set.pricing.col.input")}</th>
              <th className="num">{t("set.pricing.col.cacheCreate")}</th>
              <th className="num">{t("set.pricing.col.cacheRead")}</th>
              <th className="num">{t("set.pricing.col.output")}</th>
              <th className="pricing-reset-col" />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <PricingRow
                key={model}
                model={model}
                draft={draft}
                saved={saved}
                onChange={onChange}
                onReset={onReset}
              />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function PricingRow({
  model,
  draft,
  saved,
  onChange,
  onReset,
}: {
  model: string;
  draft: Record<string, Partial<ModelPrice>>;
  saved: Record<string, Partial<ModelPrice>>;
  onChange: (model: string, field: keyof ModelPrice, raw: string) => void;
  onReset: (model: string) => void;
}) {
  const { t } = useSettings();
  const norm = normalizeModelKey(model);
  const draftOv = draft[norm] ?? draft[model];
  const savedOv = saved[norm] ?? saved[model];
  const isCustom = !DEFAULT_PRICES[norm] && !DEFAULT_PRICES[model];

  const draftPrice = priceFor(model, draft);
  const savedPrice = priceFor(model, saved);

  const fields: (keyof ModelPrice)[] = ["input", "cacheCreate", "cacheRead", "output"];

  // Per-input raw text buffer. While the user is mid-typing, we keep the
  // exact string they entered (including `"1."`, `""`, etc.) instead of
  // round-tripping through parseFloat — otherwise the trailing dot or the
  // empty-after-backspace state gets eaten and they can't enter decimals or
  // clear a digit. The buffer is dropped on blur, so the field re-derives
  // from the committed numeric value.
  const [raw, setRaw] = useState<Partial<Record<keyof ModelPrice, string>>>({});

  const displayFor = (f: keyof ModelPrice) =>
    raw[f] !== undefined ? raw[f]! : microsToUsdStr(draftPrice[f]);

  const handleInput = (f: keyof ModelPrice, next: string) => {
    setRaw((prev) => ({ ...prev, [f]: next }));
    // Only commit when the string parses to a non-negative number. Partial
    // states like "1." parse to 1 and commit fine; "" / "abc" don't commit,
    // and the draft retains its previous value.
    const micros = usdToMicros(next);
    if (micros !== null) {
      onChange(model, f, next);
    }
  };

  const handleBlur = (f: keyof ModelPrice) => {
    setRaw((prev) => {
      if (prev[f] === undefined) return prev;
      const { [f]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  };

  const rowDirty = fields.some((f) => draftPrice[f] !== savedPrice[f])
    || (!!draftOv) !== (!!savedOv);
  const hasSavedOverride = !!savedOv && Object.keys(savedOv).length > 0;
  const hasDraftOverride = !!draftOv && Object.keys(draftOv).length > 0;
  const showResetBtn = isCustom || hasDraftOverride;

  let tag: { label: string; cls: string } | null = null;
  if (rowDirty) tag = { label: t("set.pricing.unsaved"), cls: "unsaved" };
  else if (hasSavedOverride) tag = { label: t("set.pricing.overridden"), cls: "overridden" };

  return (
    <tr className={`pricing-row ${rowDirty ? "dirty" : hasSavedOverride ? "overridden" : ""}`}>
      <td className="pricing-model">
        <span className="pricing-model-name">{model}</span>
        {tag && <span className={`pricing-edited-tag ${tag.cls}`}>{tag.label}</span>}
      </td>
      {fields.map((field) => {
        const fieldDirty = draftPrice[field] !== savedPrice[field];
        const fieldHasOverride = !!draftOv && draftOv[field] !== undefined;
        return (
          <td key={field} className="num">
            <input
              className={`pricing-input ${fieldDirty ? "dirty" : fieldHasOverride ? "overridden" : ""}`}
              type="text"
              inputMode="decimal"
              value={displayFor(field)}
              onChange={(e) => handleInput(field, e.target.value)}
              onBlur={() => handleBlur(field)}
              aria-label={`${model} ${field}`}
              spellCheck={false}
            />
          </td>
        );
      })}
      <td className="pricing-reset-col">
        {showResetBtn && (
          <button
            type="button"
            className="pricing-reset-row"
            onClick={() => onReset(model)}
            title={isCustom ? t("set.pricing.removeRow.title") : t("set.pricing.resetRow.title")}
          >
            {isCustom ? t("set.pricing.removeRow") : t("set.pricing.resetRow")}
          </button>
        )}
      </td>
    </tr>
  );
}

function PricingAddCustomForm({
  onAdd,
}: {
  onAdd: (name: string) => { ok: true } | { ok: false; reasonKey: string };
}) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const r = onAdd(name);
    if (r.ok) {
      setName("");
      setOpen(false);
      setErr(null);
    } else {
      setErr(t(r.reasonKey));
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        className="pricing-add-btn"
        onClick={() => {
          setOpen(true);
          setErr(null);
        }}
      >
        {t("set.pricing.addCustom")}
      </button>
    );
  }
  return (
    <div className="pricing-add-form">
      <input
        type="text"
        className="pricing-add-input"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (err) setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
            setErr(null);
          }
        }}
        placeholder={t("set.pricing.addCustom.placeholder")}
        spellCheck={false}
        autoFocus
      />
      <button type="button" className="pricing-add-confirm" onClick={submit}>
        {t("set.pricing.addCustom.confirm")}
      </button>
      <button
        type="button"
        className="pricing-add-cancel"
        onClick={() => {
          setOpen(false);
          setName("");
          setErr(null);
        }}
      >
        {t("set.pricing.addCustom.cancel")}
      </button>
      {err && <span className="pricing-add-err">{err}</span>}
    </div>
  );
}

function SettingsRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-meta">
        <div className="settings-row-label">{label}</div>
        {hint && <div className="settings-row-hint">{hint}</div>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SettingsView({
  backfill,
  isBackfillRunning,
  startBackfill,
  eventCount,
  dbSize,
  purgeEvents,
}: {
  backfill: BackfillProgress | null;
  isBackfillRunning: boolean;
  startBackfill: () => void;
  eventCount: number | null;
  dbSize: number | null;
  purgeEvents: (days: number) => Promise<{ deleted: number; freed_bytes: number }>;
}) {
  const { settings, update, reset, t } = useSettings();
  const [confirmPurge, setConfirmPurge] = useState(false);
  const [purgeBusy, setPurgeBusy] = useState(false);
  const [purgeMsg, setPurgeMsg] = useState<string | null>(null);
  const [ftsBusy, setFtsBusy] = useState(false);
  const [ftsMsg, setFtsMsg] = useState<string | null>(null);
  const [terminals, setTerminals] = useState<{ id: string; name: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await invoke<{ id: string; name: string }[]>(
          "list_available_terminals",
        );
        if (!cancelled) setTerminals(list);
      } catch {
        if (!cancelled) setTerminals([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const onRebuildFts = async () => {
    if (ftsBusy) return;
    setFtsBusy(true);
    setFtsMsg(null);
    try {
      const indexed = await invoke<number>("rebuild_fts_index");
      setFtsMsg(
        indexed > 0
          ? t("set.fts.done", { n: indexed.toLocaleString() })
          : t("set.fts.noop"),
      );
    } catch (e) {
      setFtsMsg(t("set.fts.failed", { error: String(e) }));
    } finally {
      setFtsBusy(false);
    }
  };

  const retentionOptions: { v: RetentionDays; l: string }[] = [
    { v: 7, l: t("set.retention.days.7") },
    { v: 30, l: t("set.retention.days.30") },
    { v: 90, l: t("set.retention.days.90") },
    { v: 0, l: t("set.retention.forever") },
  ];
  const retentionLabel =
    retentionOptions.find((o) => o.v === settings.retentionDays)?.l ?? "";

  const onPurgeClick = async () => {
    if (settings.retentionDays === 0 || purgeBusy) return;
    if (!confirmPurge) {
      setConfirmPurge(true);
      setPurgeMsg(null);
      window.setTimeout(() => setConfirmPurge(false), 4000);
      return;
    }
    setConfirmPurge(false);
    setPurgeBusy(true);
    setPurgeMsg(null);
    try {
      const res = await purgeEvents(settings.retentionDays);
      if (res.deleted === 0) {
        setPurgeMsg(t("set.retention.noop"));
      } else {
        setPurgeMsg(
          t("set.retention.done", {
            n: res.deleted.toLocaleString(),
            freed: formatBytes(res.freed_bytes),
          }),
        );
      }
    } catch (err) {
      setPurgeMsg(t("set.retention.failed", { error: String(err) }));
    } finally {
      setPurgeBusy(false);
    }
  };

  const tabOptions: { v: TabKey; l: string }[] = [
    { v: "activity", l: t("tab.activity") },
    { v: "dashboard", l: t("tab.dashboard") },
    { v: "sessions", l: t("tab.sessions") },
    { v: "cost", l: t("tab.cost") },
    { v: "policy", l: t("tab.policy") },
  ];

  const liveOptions = [
    { v: 5, l: t("dur.5s") },
    { v: 15, l: t("dur.15s") },
    { v: 30, l: t("dur.30s") },
    { v: 60, l: t("dur.1m") },
  ];

  const recentOptions = [
    { v: 1, l: t("dur.1m") },
    { v: 5, l: t("dur.5m") },
    { v: 15, l: t("dur.15m") },
    { v: 30, l: t("dur.30m") },
  ];

  let backfillStatus: string | null = null;
  if (backfill) {
    switch (backfill.phase) {
      case "started":
        backfillStatus = t("set.backfill.starting");
        break;
      case "hashes_migrated":
        backfillStatus = t("set.backfill.hashed", {
          n: backfill.migrated.toLocaleString(),
        });
        break;
      case "scanning":
        backfillStatus = t("set.backfill.scanning", {
          scanned: backfill.scanned.toLocaleString(),
          inserted: backfill.inserted.toLocaleString(),
        });
        break;
      case "done":
        backfillStatus = t("set.backfill.done", {
          n: backfill.inserted.toLocaleString(),
        });
        break;
      case "failed":
        backfillStatus = t("set.backfill.failedShort", { error: backfill.error });
        break;
    }
  }

  return (
    <div className="settings-view">
      <SettingsLayout
        sections={[
          {
            key: "general",
            label: t("set.cat.general"),
            content: (
              <>
                <div className="settings-section">
                  <div className="settings-section-title">{t("set.section.language")}</div>
                  <SettingsRow label={t("set.lang")} hint={t("set.lang.hint")}>
                    <select
                      value={settings.language}
                      onChange={(e) => update({ language: e.target.value as Lang })}
                      aria-label={t("set.lang")}
                    >
                      <option value="en">{t("lang.en")}</option>
                      <option value="zh">{t("lang.zh")}</option>
                    </select>
                  </SettingsRow>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">{t("set.section.appearance")}</div>
                  <SettingsRow label={t("set.density")} hint={t("set.density.hint")}>
                    <Segmented
                      value={settings.density}
                      options={[
                        { v: "comfortable", l: t("set.density.comfortable") },
                        { v: "compact", l: t("set.density.compact") },
                      ]}
                      onChange={(v) => update({ density: v })}
                      ariaLabel={t("set.density")}
                    />
                  </SettingsRow>
                  <SettingsRow label={t("set.reduceMotion")} hint={t("set.reduceMotion.hint")}>
                    <ToggleSwitch
                      checked={settings.reduceMotion}
                      label={settings.reduceMotion ? t("common.on") : t("common.off")}
                      onChange={(v) => update({ reduceMotion: v })}
                    />
                  </SettingsRow>
                </div>

                <div className="settings-section">
                  <div className="settings-section-title">{t("set.section.liveness")}</div>
                  <SettingsRow label={t("set.liveWindow")} hint={t("set.liveWindow.hint")}>
                    <select
                      value={settings.liveSeconds}
                      onChange={(e) => update({ liveSeconds: Number(e.target.value) })}
                      aria-label={t("set.liveWindow")}
                    >
                      {liveOptions.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                  <SettingsRow label={t("set.recentWindow")} hint={t("set.recentWindow.hint")}>
                    <select
                      value={settings.recentMinutes}
                      onChange={(e) => update({ recentMinutes: Number(e.target.value) })}
                      aria-label={t("set.recentWindow")}
                    >
                      {recentOptions.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                </div>
              </>
            ),
          },
          {
            key: "defaults",
            label: t("set.cat.defaults"),
            content: (
              <div className="settings-section">
                <div className="settings-section-title">{t("set.section.defaults")}</div>
                <SettingsRow label={t("set.defaultTab")} hint={t("set.defaultTab.hint")}>
                  <select
                    value={settings.defaultTab}
                    onChange={(e) => update({ defaultTab: e.target.value as TabKey })}
                    aria-label={t("set.defaultTab")}
                  >
                    {tabOptions.map((o) => (
                      <option key={o.v} value={o.v}>
                        {o.l}
                      </option>
                    ))}
                  </select>
                </SettingsRow>
                <SettingsRow label={t("set.showUsage")} hint={t("set.showUsage.hint")}>
                  <ToggleSwitch
                    checked={settings.defaultShowUsage}
                    label={settings.defaultShowUsage ? t("common.on") : t("common.off")}
                    onChange={(v) => update({ defaultShowUsage: v })}
                  />
                </SettingsRow>
                <SettingsRow label={t("set.autoScroll")} hint={t("set.autoScroll.hint")}>
                  <ToggleSwitch
                    checked={settings.defaultAutoScroll}
                    label={settings.defaultAutoScroll ? t("common.on") : t("common.off")}
                    onChange={(v) => update({ defaultAutoScroll: v })}
                  />
                </SettingsRow>
                {terminals.length > 0 && (
                  <SettingsRow
                    label={t("set.defaultTerminal")}
                    hint={t("set.defaultTerminal.hint")}
                  >
                    <select
                      value={settings.defaultTerminal ?? ""}
                      onChange={(e) =>
                        update({ defaultTerminal: e.target.value || null })
                      }
                      aria-label={t("set.defaultTerminal")}
                    >
                      <option value="">{t("set.defaultTerminal.auto")}</option>
                      {terminals.map((tm) => (
                        <option key={tm.id} value={tm.id}>
                          {tm.name}
                        </option>
                      ))}
                    </select>
                  </SettingsRow>
                )}
                {terminals.length > 0 && (
                  <SettingsRow
                    label={t("set.terminalProxy")}
                    hint={t("set.terminalProxy.hint")}
                  >
                    <ToggleSwitch
                      checked={settings.terminalProxyEnabled}
                      label={
                        settings.terminalProxyEnabled
                          ? t("common.on")
                          : t("common.off")
                      }
                      onChange={(v) => update({ terminalProxyEnabled: v })}
                    />
                  </SettingsRow>
                )}
                {terminals.length > 0 && settings.terminalProxyEnabled && (
                  <SettingsRow
                    label={t("set.terminalProxy.addressLabel")}
                    hint={t("set.terminalProxy.addressHint")}
                  >
                    <input
                      type="text"
                      className="settings-input"
                      value={settings.terminalProxyAddress}
                      onChange={(e) =>
                        update({ terminalProxyAddress: e.target.value })
                      }
                      placeholder={t("set.terminalProxy.placeholder")}
                      spellCheck={false}
                      aria-label={t("set.terminalProxy.addressLabel")}
                    />
                  </SettingsRow>
                )}
              </div>
            ),
          },
          {
            key: "pricing",
            label: t("set.cat.pricing"),
            content: <PricingSection />,
          },
          {
            key: "data",
            label: t("set.cat.data"),
            content: (
              <div className="settings-section">
                <div className="settings-section-title">{t("set.section.data")}</div>
                <SettingsRow label={t("set.backfill")} hint={t("set.backfill.hint")}>
                  <div className="settings-inline">
                    <button
                      className="settings-btn"
                      onClick={startBackfill}
                      disabled={isBackfillRunning}
                    >
                      {isBackfillRunning ? t("set.backfill.running") : t("set.backfill.run")}
                    </button>
                    {backfillStatus && (
                      <span className="settings-status">{backfillStatus}</span>
                    )}
                  </div>
                </SettingsRow>
                <SettingsRow label={t("set.fts")} hint={t("set.fts.hint")}>
                  <div className="settings-inline">
                    <button
                      className="settings-btn"
                      onClick={onRebuildFts}
                      disabled={ftsBusy}
                    >
                      {ftsBusy ? t("set.fts.running") : t("set.fts.run")}
                    </button>
                    {ftsMsg && <span className="settings-status">{ftsMsg}</span>}
                  </div>
                </SettingsRow>
                <SettingsRow label={t("set.eventCount")} hint={t("set.eventCount.hint")}>
                  <span className="settings-stat">
                    {eventCount === null ? "…" : eventCount.toLocaleString()}
                  </span>
                </SettingsRow>
                <SettingsRow label={t("set.dbSize")} hint={t("set.dbSize.hint")}>
                  <span className="settings-stat">
                    {dbSize === null ? "…" : formatBytes(dbSize)}
                  </span>
                </SettingsRow>
                <SettingsRow label={t("set.retention")} hint={t("set.retention.hint")}>
                  <div className="settings-inline">
                    <select
                      value={settings.retentionDays}
                      onChange={(e) => {
                        update({ retentionDays: Number(e.target.value) as RetentionDays });
                        setConfirmPurge(false);
                        setPurgeMsg(null);
                      }}
                      aria-label={t("set.retention")}
                    >
                      {retentionOptions.map((o) => (
                        <option key={o.v} value={o.v}>
                          {o.l}
                        </option>
                      ))}
                    </select>
                    <button
                      className={`settings-btn ${confirmPurge ? "settings-btn-danger" : ""}`}
                      onClick={onPurgeClick}
                      disabled={settings.retentionDays === 0 || purgeBusy}
                      title={
                        settings.retentionDays === 0
                          ? t("set.retention.forever")
                          : undefined
                      }
                    >
                      {purgeBusy
                        ? t("set.retention.running")
                        : confirmPurge
                        ? t("set.retention.confirm", { label: retentionLabel })
                        : t("set.retention.run")}
                    </button>
                    {purgeMsg && <span className="settings-status">{purgeMsg}</span>}
                  </div>
                </SettingsRow>
              </div>
            ),
          },
          {
            key: "about",
            label: t("set.cat.about"),
            content: (
              <div className="settings-section">
                <div className="settings-section-title">{t("set.section.about")}</div>
                <SettingsRow label={t("set.reset")} hint={t("set.reset.hint")}>
                  <button className="settings-btn settings-btn-danger" onClick={reset}>
                    {t("set.reset.btn")}
                  </button>
                </SettingsRow>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

interface SettingsCategory {
  key: string;
  label: string;
  content: ReactNode;
}

function SettingsLayout({ sections }: { sections: SettingsCategory[] }) {
  const [active, setActive] = useState(sections[0]?.key ?? "");
  const current = sections.find((s) => s.key === active) ?? sections[0];
  return (
    <div className="settings-layout">
      <nav className="settings-sidebar" aria-label="Settings categories">
        {sections.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`settings-sidebar-item ${s.key === current?.key ? "active" : ""}`}
            onClick={() => setActive(s.key)}
            aria-current={s.key === current?.key ? "page" : undefined}
          >
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-pane">{current?.content}</div>
    </div>
  );
}

function BackfillBanner({
  p,
  firstRun,
  onDismiss,
}: {
  p: BackfillProgress;
  firstRun: boolean;
  onDismiss: () => void;
}) {
  const { t } = useSettings();
  let label = "";
  let cls = "info";
  switch (p.phase) {
    case "started":
      label = firstRun ? t("bf.welcome") : t("bf.starting");
      break;
    case "hashes_migrated":
      label = t("bf.migrated", { n: p.migrated });
      break;
    case "scanning":
      label = firstRun
        ? t("bf.scanningFirst", {
            scanned: p.scanned.toLocaleString(),
            inserted: p.inserted.toLocaleString(),
          })
        : t("bf.scanning", {
            scanned: p.scanned.toLocaleString(),
            inserted: p.inserted.toLocaleString(),
          });
      break;
    case "done":
      label = firstRun
        ? t("bf.readyFirst", { n: p.inserted.toLocaleString() })
        : t("bf.done", {
            inserted: p.inserted.toLocaleString(),
            scanned: p.scanned.toLocaleString(),
            hashed: p.hashes_migrated.toLocaleString(),
          });
      cls = "success";
      break;
    case "failed":
      label = t("bf.failed", { error: p.error });
      cls = "error";
      break;
  }
  const showSpinner =
    p.phase === "started" ||
    p.phase === "hashes_migrated" ||
    p.phase === "fts_indexed" ||
    p.phase === "scanning";
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
  const { t } = useSettings();
  const levelLabel = {
    low: t("risk.low"),
    med: t("risk.med"),
    high: t("risk.high"),
  }[risk.level];
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
        <div className="risk-window">{t("risk.window", { n: risk.windowSize })}</div>
        {risk.findings.length === 0 ? (
          <div className="risk-clean">{t("risk.clean")}</div>
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

function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: { v: T; l: string }[];
  onChange: (v: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          className={`seg ${value === o.v ? "active" : ""}`}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
        >
          {o.l}
        </button>
      ))}
    </div>
  );
}

function ToggleSwitch({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      className={`toggle-switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
      role="switch"
      aria-checked={checked}
    >
      <span className="toggle-track" />
      <span className="toggle-label">{label}</span>
    </button>
  );
}

function EventRow({
  ev,
  model,
  onOpenSession,
  expanded,
  onToggleExpand,
}: {
  ev: AgentEvent;
  model?: string | null;
  onOpenSession?: (sessionId: string) => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const { settings } = useSettings();
  const lvl = riskLevel(ev.risk_tags);
  const { label: kindLabel, detail, kindCls } = renderKind(ev.kind);
  const ts = new Date(ev.timestamp).toLocaleTimeString("en-GB", { hour12: false });
  const isUsage = ev.kind.type === "usage";
  const usageCost = ev.usage ? computeCostMicros(ev.usage, settings.customPricing) : 0;
  const usageDetail = ev.usage ? formatUsageDetail(ev.usage, usageCost) : "";
  const displayDetail = isUsage ? usageDetail : detail;
  const clickable = !!onOpenSession;
  // Prefer the explicit usage model on the row itself (always authoritative);
  // otherwise fall back to the active model threaded through from ActivityView.
  const shownModel = ev.usage?.model ?? model ?? null;

  const fullText = fullEventText(ev.kind);
  // A row is expandable when its full text has content the single-line detail
  // can't show — either a newline, or it's meaningfully longer than the
  // one-line summary already in the column.
  const expandable =
    !!onToggleExpand &&
    fullText.length > 0 &&
    (fullText.includes("\n") || fullText.length > displayDetail.length + 8);

  // Click priority: expand inline when there's more to see, else fall back
  // to opening the session detail. This keeps the row click useful for
  // every row but stops the jarring page jump on every interaction.
  const onRowClick = expandable
    ? () => onToggleExpand?.()
    : clickable
    ? () => onOpenSession!(ev.session_id)
    : undefined;
  const rowTitle = expandable
    ? (expanded ? "Collapse" : "Click to expand")
    : clickable
    ? "Open session detail"
    : undefined;
  const rowInteractive = !!onRowClick;

  return (
    <div className={`event-row-wrap${expanded ? " is-expanded" : ""}`}>
      <div
        className={`row risk-${lvl} ${isUsage ? "row-usage" : ""} ${rowInteractive ? "row-clickable" : ""}`}
        onClick={onRowClick}
        title={rowTitle}
        role={rowInteractive ? "button" : undefined}
      >
        <span className="ts">{ts}</span>
        <span className={`agent agent-${ev.agent}`}>{ev.agent}</span>
        <span className={`kind ${kindCls}`}>{kindLabel}</span>
        <span className="detail" title={displayDetail}>{displayDetail}</span>
        <span className="row-expand">
          {expandable && (
            <button
              type="button"
              className="row-expand-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
              aria-label={expanded ? "Collapse content" : "Expand content"}
              aria-expanded={!!expanded}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
        </span>
        <span className="model" title={shownModel ?? ""}>
          {shownModel ? shortModel(shownModel) : "—"}
        </span>
        <span className="cwd" title={ev.cwd ?? ""}>{shortenCwd(ev.cwd)}</span>
        <span className="risk">
          {ev.usage && !isUsage ? (
            <span className="cost-pill">{fmtUSD(usageCost)}</span>
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
      {expanded && expandable && (
        <div className="row-expanded-wrap">
          <div className="row-expanded-pane">{renderMarkdownLite(fullText)}</div>
          {clickable && (
            <div className="row-expanded-actions">
              <button
                type="button"
                className="row-expanded-open"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSession!(ev.session_id);
                }}
              >
                打开会话 →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default App;
