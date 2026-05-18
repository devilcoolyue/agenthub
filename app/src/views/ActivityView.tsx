import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, AgentEvent } from "../types";
import { riskLevel } from "../types";
import { useSettings } from "../settings";
import { EventRow } from "../components/EventRow";
import { Segmented } from "../components/Segmented";
import { ToggleSwitch } from "../components/ToggleSwitch";
import "./ActivityView.css";

export function ActivityView({
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
