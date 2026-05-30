import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Agent, DailyCost, ModelCost } from "../types";
import { fmtTokens, fmtUSD } from "../types";
import { computeCostMicros } from "../pricing";
import { useSettings } from "../settings";
import { useAnimatedNumber } from "../hooks";
import claudeIcon from "../assets/claude.svg";
import codexIcon from "../assets/codex.svg";
import cursorIcon from "../assets/cursor.svg";
import "./CostView.css";

// Cursor bills server-side (no local token/cost data), so it never appears in
// the cost charts — but the icon map must stay total over `Agent`.
const AGENT_ICON: Record<Agent, string> = {
  "claude-code": claudeIcon,
  codex: codexIcon,
  cursor: cursorIcon,
};

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

export function CostView() {
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
