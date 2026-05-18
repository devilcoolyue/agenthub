import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentEvent } from "../types";
import { useSettings } from "../settings";
import { type Thresholds, cwdLabel, livenessOf, shortenCwd } from "../utils";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";

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

export function DashboardView({
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
