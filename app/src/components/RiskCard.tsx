import type { RiskSummary } from "../types";
import { useSettings } from "../settings";
import "./RiskCard.css";

export function RiskCard({ risk }: { risk: RiskSummary }) {
  const { t } = useSettings();
  const levelLabel = {
    low: t("risk.low"),
    med: t("risk.med"),
    high: t("risk.high"),
  }[risk.level];
  const dash = 2 * Math.PI * 28;
  const progress = (risk.score / 100) * dash;
  return (
    <div className={`risk-card level-${risk.level}`}>
      <div className="risk-ring">
        <svg width="76" height="76" viewBox="0 0 76 76">
          <circle cx="38" cy="38" r="28" stroke="rgba(255,255,255,0.06)" strokeWidth="6" fill="none" />
          <circle
            cx="38" cy="38" r="28"
            stroke="currentColor" strokeWidth="6" fill="none"
            strokeLinecap="round"
            strokeDasharray={`${progress} ${dash}`}
            transform="rotate(-90 38 38)"
            style={{ transition: "stroke-dasharray 300ms ease" }}
          />
        </svg>
        <div className="risk-score-num">{risk.score}</div>
      </div>
      <div className="risk-meta">
        <div className="risk-level-label">{levelLabel}</div>
        <div className="risk-window">{t("risk.window", { n: risk.windowSize })}</div>
        {risk.findings.length === 0 ? (
          <div className="risk-clean">{t("risk.clean")}</div>
        ) : (
          <div className="risk-findings">
            {risk.findings.slice(0, 3).map((f) => (
              <div key={f.tag} className={`finding tag-${f.tag}`}>
                <span className="finding-tag">{f.tag}</span>
                <span className="finding-count">{f.count}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
