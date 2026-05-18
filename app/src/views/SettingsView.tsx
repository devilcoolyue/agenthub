import { useEffect, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { BackfillProgress } from "../types";
import type { Lang } from "../i18n";
import {
  type RetentionDays,
  type TabKey,
  useSettings,
} from "../settings";
import { formatBytes } from "../utils";
import { Segmented } from "../components/Segmented";
import { ToggleSwitch } from "../components/ToggleSwitch";
import { PricingSection } from "./PricingSection";
import "./SettingsView.css";

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

export function SettingsView({
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
