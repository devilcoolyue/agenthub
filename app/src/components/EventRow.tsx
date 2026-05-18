import type { AgentEvent } from "../types";
import { riskLevel, fmtUSD } from "../types";
import { computeCostMicros } from "../pricing";
import { useSettings } from "../settings";
import { shortenCwd } from "../utils";
import {
  formatUsageDetail,
  fullEventText,
  renderKind,
  renderMarkdownLite,
  shortModel,
} from "../eventRender";
import "./EventRow.css";

export function EventRow({
  ev,
  model,
  onOpenSession,
  expanded,
  onToggleExpand,
}: {
  ev: AgentEvent;
  model?: string | null;
  onOpenSession?: (sessionId: string) => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
  const { settings } = useSettings();
  const lvl = riskLevel(ev.risk_tags);
  const { label: kindLabel, detail, kindCls } = renderKind(ev.kind);
  const ts = new Date(ev.timestamp).toLocaleTimeString("en-GB", { hour12: false });
  const isUsage = ev.kind.type === "usage";
  const usageCost = ev.usage ? computeCostMicros(ev.usage, settings.customPricing) : 0;
  const usageDetail = ev.usage ? formatUsageDetail(ev.usage, usageCost) : "";
  const displayDetail = isUsage ? usageDetail : detail;
  const clickable = !!onOpenSession;
  // Prefer the explicit usage model on the row itself (always authoritative);
  // otherwise fall back to the active model threaded through from ActivityView.
  const shownModel = ev.usage?.model ?? model ?? null;

  const fullText = fullEventText(ev.kind);
  // A row is expandable when its full text has content the single-line detail
  // can't show — either a newline, or it's meaningfully longer than the
  // one-line summary already in the column.
  const expandable =
    !!onToggleExpand &&
    fullText.length > 0 &&
    (fullText.includes("\n") || fullText.length > displayDetail.length + 8);

  // Click priority: expand inline when there's more to see, else fall back
  // to opening the session detail. This keeps the row click useful for
  // every row but stops the jarring page jump on every interaction.
  const onRowClick = expandable
    ? () => onToggleExpand?.()
    : clickable
    ? () => onOpenSession!(ev.session_id)
    : undefined;
  const rowTitle = expandable
    ? (expanded ? "Collapse" : "Click to expand")
    : clickable
    ? "Open session detail"
    : undefined;
  const rowInteractive = !!onRowClick;

  return (
    <div className={`event-row-wrap${expanded ? " is-expanded" : ""}`}>
      <div
        className={`row risk-${lvl} ${isUsage ? "row-usage" : ""} ${rowInteractive ? "row-clickable" : ""}`}
        onClick={onRowClick}
        title={rowTitle}
        role={rowInteractive ? "button" : undefined}
      >
        <span className="ts">{ts}</span>
        <span className={`agent agent-${ev.agent}`}>{ev.agent}</span>
        <span className={`kind ${kindCls}`}>{kindLabel}</span>
        <span className="detail" title={displayDetail}>{displayDetail}</span>
        <span className="row-expand">
          {expandable && (
            <button
              type="button"
              className="row-expand-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpand?.();
              }}
              aria-label={expanded ? "Collapse content" : "Expand content"}
              aria-expanded={!!expanded}
              title={expanded ? "Collapse" : "Expand"}
            >
              {expanded ? "▾" : "▸"}
            </button>
          )}
        </span>
        <span className="model" title={shownModel ?? ""}>
          {shownModel ? shortModel(shownModel) : "—"}
        </span>
        <span className="cwd" title={ev.cwd ?? ""}>{shortenCwd(ev.cwd)}</span>
        <span className="risk">
          {ev.usage && !isUsage ? (
            <span className="cost-pill">{fmtUSD(usageCost)}</span>
          ) : ev.risk_tags.length === 0 ? (
            <span className="dot dot-low">·</span>
          ) : (
            <>
              <span className={`dot dot-${lvl}`}>●</span>
              <span className="tags">{ev.risk_tags.join(",")}</span>
            </>
          )}
        </span>
      </div>
      {expanded && expandable && (
        <div className="row-expanded-wrap">
          <div className="row-expanded-pane">{renderMarkdownLite(fullText)}</div>
          {clickable && (
            <div className="row-expanded-actions">
              <button
                type="button"
                className="row-expanded-open"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSession!(ev.session_id);
                }}
              >
                打开会话 →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
