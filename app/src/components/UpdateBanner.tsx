import { useEffect, useState } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { useSettings } from "../settings";
import "./UpdateBanner.css";

type Phase =
  | { kind: "available"; update: Update }
  | { kind: "downloading"; pct: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

/** Checks for a newer release on launch and, if one exists, offers a one-click
 *  download + relaunch. Silent when already up to date or when the check fails
 *  (e.g. offline) — we never block the app on the updater. */
export function UpdateBanner() {
  const { t } = useSettings();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const update = await check();
        if (!cancelled && update) setPhase({ kind: "available", update });
      } catch {
        // Offline / no endpoint / dev build — stay silent.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (phase === null || dismissed) return null;

  const install = async (update: Update) => {
    let total = 0;
    let received = 0;
    setPhase({ kind: "downloading", pct: null });
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") {
          total = ev.data.contentLength ?? 0;
        } else if (ev.event === "Progress") {
          received += ev.data.chunkLength;
          setPhase({
            kind: "downloading",
            pct: total > 0 ? Math.round((received / total) * 100) : null,
          });
        } else if (ev.event === "Finished") {
          setPhase({ kind: "ready" });
        }
      });
      await relaunch();
    } catch (err) {
      setPhase({ kind: "error", message: String(err) });
    }
  };

  let cls = "info";
  let label = "";
  let action: React.ReactNode = null;

  switch (phase.kind) {
    case "available":
      label = t("update.available", { version: phase.update.version });
      action = (
        <button className="ub-btn" onClick={() => install(phase.update)}>
          {t("update.install")}
        </button>
      );
      break;
    case "downloading":
      label =
        phase.pct === null
          ? t("update.downloading")
          : t("update.downloadingPct", { pct: phase.pct });
      break;
    case "ready":
      label = t("update.relaunching");
      break;
    case "error":
      cls = "error";
      label = t("update.error", { error: phase.message });
      break;
  }

  const showSpinner = phase.kind === "downloading" || phase.kind === "ready";
  const dismissable = phase.kind === "available" || phase.kind === "error";

  return (
    <div className={`update-banner ${cls}`}>
      {showSpinner && <span className="ub-spinner" />}
      <span className="ub-msg">{label}</span>
      {action}
      {dismissable && (
        <button className="ub-dismiss" onClick={() => setDismissed(true)}>
          ×
        </button>
      )}
    </div>
  );
}
