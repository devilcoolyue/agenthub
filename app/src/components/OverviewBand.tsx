import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentDayStat, AgentEvent, AgentPolicy, DailyCost } from "../types";
import { fmtUSD } from "../types";
import { computeCostMicros } from "../pricing";
import { useSettings } from "../settings";
import { type Thresholds, livenessOf } from "../utils";
import "./OverviewBand.css";

type Status = "active" | "idle" | "config-only";

interface AgentCard {
  agent: string;
  status: Status;
  /** null = not applicable (Cursor has no activity). */
  events: number | null;
  costMicros: number | null;
  activityRisk: number;
  configRisk: number;
}

function ymdLocal(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Agents with at least one session that is "live" right now, derived from the
 *  rolling event window (same liveness model as the dashboard stage). */
function activeAgents(
  events: AgentEvent[],
  now: number,
  thresholds: Thresholds,
): Set<string> {
  const lastBySession = new Map<string, { agent: string; ts: number }>();
  for (const e of events) {
    const ts = Date.parse(e.timestamp);
    if (Number.isNaN(ts)) continue;
    const prev = lastBySession.get(e.session_id);
    if (!prev || ts > prev.ts) lastBySession.set(e.session_id, { agent: e.agent, ts });
  }
  const active = new Set<string>();
  for (const { agent, ts } of lastBySession.values()) {
    if (livenessOf(ts, now, thresholds) === "live") active.add(agent);
  }
  return active;
}

export function OverviewBand({
  events,
  now,
}: {
  events: AgentEvent[];
  now: number;
}) {
  const { settings, thresholds, t } = useSettings();
  const pricing = settings.customPricing;
  const [today, setToday] = useState<AgentDayStat[] | null>(null);
  const [daily, setDaily] = useState<DailyCost[] | null>(null);
  const [policies, setPolicies] = useState<AgentPolicy[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [ts, d, p] = await Promise.all([
        invoke<AgentDayStat[]>("get_today_agent_stats"),
        invoke<DailyCost[]>("get_daily_cost", { days: 1 }),
        invoke<AgentPolicy[]>("get_agent_policies"),
      ]);
      if (cancelled) return;
      setToday(ts);
      setDaily(d);
      setPolicies(p);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Hold layout until the first fetch resolves, to avoid a flash of empty cards.
  if (today === null || daily === null || policies === null) return null;

  const todayKey = ymdLocal(new Date());
  const costByAgent: Record<string, number> = {};
  for (const d of daily) {
    if (d.day !== todayKey) continue;
    costByAgent[d.agent] = (costByAgent[d.agent] ?? 0) + computeCostMicros(d, pricing);
  }
  const statByAgent = new Map(today.map((s) => [s.agent, s]));
  const configRiskByAgent = new Map(policies.map((p) => [p.agent, p.high_risk_count]));
  const active = activeAgents(events, now, thresholds);

  // Cursor shows if it has config on disk OR any tracked activity. It's a real
  // activity agent now (events / status / risk are live), but bills server-side
  // so it has no local cost — only its cost metric reads N/A.
  const hasCursor =
    policies.some((p) => p.agent === "cursor") ||
    statByAgent.has("cursor") ||
    active.has("cursor");
  const agents = ["claude-code", "codex", ...(hasCursor ? ["cursor"] : [])];

  const cards: AgentCard[] = agents.map((agent) => {
    const noCost = agent === "cursor"; // Cursor bills server-side; no local cost
    const s = statByAgent.get(agent);
    return {
      agent,
      status: active.has(agent) ? "active" : "idle",
      events: s?.events ?? 0,
      costMicros: noCost ? null : costByAgent[agent] ?? 0,
      activityRisk: s?.high_risk ?? 0,
      configRisk: configRiskByAgent.get(agent) ?? 0,
    };
  });

  return (
    <div className="overview-band">
      {cards.map((c) => (
        <OverviewCard key={c.agent} c={c} t={t} />
      ))}
    </div>
  );
}

function OverviewCard({
  c,
  t,
}: {
  c: AgentCard;
  t: ReturnType<typeof useSettings>["t"];
}) {
  const na = t("dash.ov.na");
  const totalRisk = c.activityRisk + c.configRisk;
  const statusLabel =
    c.status === "active"
      ? t("dash.ov.status.active")
      : c.status === "idle"
        ? t("dash.ov.status.idle")
        : t("dash.ov.status.configOnly");

  return (
    <div className={`ov-card ${totalRisk > 0 ? "has-risk" : ""}`}>
      <div className="ov-head">
        <span className={`ov-dot agent-${c.agent}`} />
        <span className={`ov-name agent-${c.agent}`}>{c.agent}</span>
        <span className={`ov-status ov-status-${c.status}`}>
          {c.status === "active" && <span className="sc-live-dot" />}
          {statusLabel}
        </span>
      </div>

      <div className="ov-metrics">
        <div className="ov-metric">
          <span className="ov-metric-val">
            {c.events === null ? na : c.events}
          </span>
          <span className="ov-metric-lbl">{t("dash.ov.events")}</span>
        </div>
        <div className="ov-metric">
          <span className="ov-metric-val">
            {c.costMicros === null ? na : fmtUSD(c.costMicros)}
          </span>
          <span className="ov-metric-lbl">{t("dash.ov.cost")}</span>
        </div>
        <div className="ov-metric">
          <span className={`ov-metric-val ${totalRisk > 0 ? "risk" : ""}`}>
            {totalRisk === 0 ? "0" : totalRisk}
          </span>
          <span className="ov-metric-lbl">{t("dash.ov.risk")}</span>
        </div>
      </div>

      <div className="ov-risk-detail">
        {c.events === null ? (
          <span className="ov-risk-part">
            {t("dash.ov.risk.config", { n: c.configRisk })}
          </span>
        ) : (
          <>
            <span className={`ov-risk-part ${c.activityRisk > 0 ? "risk" : ""}`}>
              {t("dash.ov.risk.activity", { n: c.activityRisk })}
            </span>
            <span className="ov-risk-sep">·</span>
            <span className={`ov-risk-part ${c.configRisk > 0 ? "risk" : ""}`}>
              {t("dash.ov.risk.config", { n: c.configRisk })}
            </span>
          </>
        )}
      </div>
    </div>
  );
}
