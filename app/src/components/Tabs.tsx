import { type TabKey, useSettings } from "../settings";
import "./Tabs.css";

export type View =
  | { type: "activity" }
  | { type: "dashboard" }
  | { type: "sessions" }
  | { type: "session-detail"; sessionId: string }
  | { type: "cost" }
  | { type: "policy" }
  | { type: "settings" };

export function Tabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  const { t } = useSettings();
  const tab: TabKey | "settings" =
    view.type === "session-detail" ? "sessions" : view.type;
  return (
    <nav className="tabs">
      <button
        className={`tab ${tab === "activity" ? "active" : ""}`}
        onClick={() => onView({ type: "activity" })}
      >
        {t("tab.activity")}
      </button>
      <button
        className={`tab ${tab === "dashboard" ? "active" : ""}`}
        onClick={() => onView({ type: "dashboard" })}
      >
        {t("tab.dashboard")}
      </button>
      <button
        className={`tab ${tab === "sessions" ? "active" : ""}`}
        onClick={() => onView({ type: "sessions" })}
      >
        {t("tab.sessions")}
      </button>
      <button
        className={`tab ${tab === "cost" ? "active" : ""}`}
        onClick={() => onView({ type: "cost" })}
      >
        {t("tab.cost")}
      </button>
      <button
        className={`tab ${tab === "policy" ? "active" : ""}`}
        onClick={() => onView({ type: "policy" })}
      >
        {t("tab.policy")}
      </button>
      <span className="tabs-spacer" />
      <button
        className={`tab tab-settings ${tab === "settings" ? "active" : ""}`}
        onClick={() => onView({ type: "settings" })}
        title={t("tab.settings")}
        aria-label={t("tab.settings")}
      >
        <span className="tab-gear" aria-hidden>⚙</span>
        {t("tab.settings")}
      </button>
    </nav>
  );
}
