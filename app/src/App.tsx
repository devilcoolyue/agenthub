import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { AgentEvent, BackfillProgress } from "./types";
import { computeRiskSummary } from "./types";
import {
  type Settings,
  type SettingsContextValue,
  DEFAULT_SETTINGS,
  SettingsContext,
  loadSettings,
  saveSettings,
} from "./settings";
import { type Thresholds } from "./utils";
import { makeTranslator } from "./i18n";
import { useNow } from "./hooks";
// Base styles + global modifiers. Density and motion override component
// rules, so they're imported last to stay last in the CSS cascade.
import "./styles/base.css";
import { BackfillBanner } from "./components/BackfillBanner";
import { RiskCard } from "./components/RiskCard";
import { Stat } from "./components/Stat";
import { type View, Tabs } from "./components/Tabs";
import { ActivityView } from "./views/ActivityView";
import { CostView } from "./views/CostView";
import { DashboardView } from "./views/DashboardView";
import { PolicyView } from "./views/PolicyView";
import { SessionDetailView } from "./views/SessionDetailView";
import { SessionsView } from "./views/SessionsView";
import { SettingsView } from "./views/SettingsView";
import "./styles/density.css";
import "./styles/motion.css";

const MAX_EVENTS = 500;

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

export default App;
