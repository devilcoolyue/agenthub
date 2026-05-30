import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentEvent, ModelUsage } from "../types";
import { fmtTokens, fmtUSD, riskLevel } from "../types";
import { computeCostMicros } from "../pricing";
import { useSettings } from "../settings";
import { formatRange, livenessOf, shortenCwd } from "../utils";
import { EventRow } from "../components/EventRow";
import "./SessionDetailView.css";

// How many timeline rows to mount per lazy-load page. The detail view keeps the
// whole session in memory but only renders this many DOM rows at a time, growing
// as the user scrolls — keeps large sessions snappy on WebView2 (Windows).
const EVENT_PAGE = 120;

export function SessionDetailView({
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
  const [visibleCount, setVisibleCount] = useState(EVENT_PAGE);
  const listRef = useRef<HTMLDivElement | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Effective default: persisted choice if it's still installed; otherwise
  // fall back to the first detected terminal for the current OS.
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

  // Timeline rows in reverse-chronological order (newest first). Model is
  // threaded oldest→newest *first* — a model "sticks" until the next usage
  // event — and only then reversed, so every row still shows the model that
  // was live at its own timestamp. origIndex stays as a stable React key.
  const rows = useMemo(() => {
    if (!events) return [];
    let active: string | null = null;
    const out = events.map((ev, origIndex) => {
      if (ev.usage?.model) active = ev.usage.model;
      else if (ev.kind.type === "session_start" && ev.kind.model && !active)
        active = ev.kind.model;
      return { ev, model: active, origIndex };
    });
    out.reverse();
    // Day separators: walking newest→oldest, mark the first row of each calendar
    // day so the timeline can show a date header whenever the day changes —
    // sessions often span multiple days and bare HH:MM:SS hides that.
    let prevDay: string | null = null;
    return out.map((r) => {
      const d = new Date(r.ev.timestamp);
      const dayKey = d.toDateString();
      const showDay = dayKey !== prevDay;
      prevDay = dayKey;
      const dayLabel = showDay
        ? d.toLocaleDateString(undefined, {
            month: "long",
            day: "numeric",
            weekday: "short",
          })
        : "";
      return { ...r, showDay, dayLabel };
    });
  }, [events]);

  // Reset the lazy window when switching sessions so we don't carry a large
  // visibleCount onto a fresh (possibly smaller) timeline.
  useEffect(() => {
    setVisibleCount(EVENT_PAGE);
  }, [sessionId]);

  // Grow the lazy window as the bottom sentinel scrolls into view. Root is the
  // scrollable event-list; rootMargin pre-loads the next page before the user
  // reaches the very bottom.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = listRef.current;
    if (!sentinel || !root || visibleCount >= rows.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + EVENT_PAGE, rows.length));
        }
      },
      { root, rootMargin: "400px 0px" },
    );
    io.observe(sentinel);
    return () => io.disconnect();
  }, [rows.length, visibleCount]);

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
      <div className="event-list" ref={listRef}>
        {events === null && <div className="empty">{t("detail.loading")}</div>}
        {events && events.length === 0 && <div className="empty">{t("detail.empty")}</div>}
        {rows.slice(0, visibleCount).map(({ ev, model, origIndex, showDay, dayLabel }) => (
          <Fragment key={origIndex}>
            {showDay && (
              <div className="event-day-sep">
                <span className="event-day-label">{dayLabel}</span>
              </div>
            )}
            <EventRow ev={ev} model={model} />
          </Fragment>
        ))}
        {visibleCount < rows.length && (
          <div ref={sentinelRef} className="event-list-sentinel" aria-hidden />
        )}
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
