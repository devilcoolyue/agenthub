import type { BackfillProgress } from "../types";
import { useSettings } from "../settings";
import "./BackfillBanner.css";

export function BackfillBanner({
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
