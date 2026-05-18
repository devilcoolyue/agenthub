import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  SessionCategory,
  SessionSummary,
  SessionsFilter,
} from "../types";
import { useSettings } from "../settings";
import {
  type Liveness,
  cwdLabel,
  formatRange,
  livenessOf,
  shortenCwd,
} from "../utils";

type CategorySelection =
  | { kind: "all" }
  | { kind: "high-risk" }
  | { kind: "cwd"; cwd: string | null };

const PAGE_SIZE = 20;

export function SessionsView({
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
