import type { ReactNode } from "react";
import type { EventKind, Usage } from "./types";
import { fmtTokens, fmtUSD } from "./types";

// Short label for the row's narrow column. Only strip Anthropic's date
// suffix — keep the `claude-` / `gpt-` prefixes since stripping them can
// leave useless remnants like "5" for codex's `gpt-5`.
export function shortModel(m: string): string {
  return m.replace(/-\d{8}$/, "");
}

export function formatUsageDetail(u: Usage, costMicros: number): string {
  const parts: string[] = [];
  if (u.model) parts.push(u.model);
  parts.push(`↓ ${fmtTokens(u.input_tokens)}`);
  if (u.cache_read_tokens > 0) parts.push(`cache ${fmtTokens(u.cache_read_tokens)}`);
  if (u.cache_creation_tokens > 0) parts.push(`+cache ${fmtTokens(u.cache_creation_tokens)}`);
  parts.push(`↑ ${fmtTokens(u.output_tokens + u.reasoning_tokens)}`);
  parts.push(fmtUSD(costMicros));
  return parts.join("  ");
}

export function renderKind(k: EventKind): { label: string; detail: string; kindCls: string } {
  switch (k.type) {
    case "session_start":
      return { label: "session", detail: `start  model=${k.model ?? "?"}  v=${k.version ?? "?"}`, kindCls: "k-session" };
    case "user_prompt":
      return { label: "user", detail: oneLine(k.text), kindCls: "k-user" };
    case "assistant_thinking":
      return { label: "think", detail: "(thinking…)", kindCls: "k-think" };
    case "assistant_text":
      return { label: "reply", detail: oneLine(k.text), kindCls: "k-reply" };
    case "tool_use":
      return { label: k.name, detail: oneLine(k.summary), kindCls: "k-tool" };
    case "tool_result":
      return { label: k.ok ? "ok" : "err", detail: oneLine(k.summary), kindCls: k.ok ? "k-ok" : "k-err" };
    case "system":
      return { label: "system", detail: oneLine(k.text), kindCls: "k-system" };
    case "usage":
      return { label: "usage", detail: "", kindCls: "k-usage" };
    case "other":
      return { label: k.tag, detail: "", kindCls: "k-system" };
  }
}

// Strips ANSI/VT escape sequences (color, cursor, OSC) that show up in
// tool_result summaries captured from `tail`, `cat`, build output, etc.
// Without this the activity column renders literal `[1m[94m...[0m` noise.
// eslint-disable-next-line no-control-regex
const ANSI_CSI = /\x1B\[[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ANSI_OSC = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g;
// eslint-disable-next-line no-control-regex
const ANSI_OTHER = /\x1B[@-Z\\-_]/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_OTHER, "");
}

export function oneLine(s: string): string {
  return stripAnsi(s).replace(/\n/g, " ⏎ ").trim();
}

// The full (multi-line, ANSI-stripped) text shown in the inline expand pane.
// Empty string ⇒ nothing to expand for this event kind.
export function fullEventText(k: EventKind): string {
  switch (k.type) {
    case "user_prompt":
    case "assistant_text":
    case "system":
      return stripAnsi(k.text);
    case "tool_use":
    case "tool_result":
      return stripAnsi(k.summary);
    case "session_start":
      return `model = ${k.model ?? "?"}\nversion = ${k.version ?? "?"}`;
    default:
      return "";
  }
}

// Lightweight markdown renderer for the expand pane. Handles fenced code
// blocks (```), inline code (`), and bold (**). Not a full parser — just
// enough to make assistant replies and tool output readable. Preserves
// newlines via white-space: pre-wrap on the container.
export function renderMarkdownLite(text: string): ReactNode[] {
  const blocks: ReactNode[] = [];
  const fenceRe = /```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g;
  let lastIdx = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (m.index > lastIdx) {
      blocks.push(
        <span key={`t-${key++}`}>
          {renderInlineMd(text.slice(lastIdx, m.index), `i-${key++}`)}
        </span>,
      );
    }
    blocks.push(
      <pre key={`cb-${key++}`} className="md-codeblock">
        {m[2]}
      </pre>,
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    blocks.push(
      <span key={`t-${key++}`}>
        {renderInlineMd(text.slice(lastIdx), `i-${key++}`)}
      </span>,
    );
  }
  return blocks;
}

function renderInlineMd(text: string, baseKey: string): ReactNode[] {
  // Single pass alternating bold (**...**) and inline code (`...`).
  // Backticks/asterisks that aren't paired pass through as plain text.
  const out: ReactNode[] = [];
  const re = /\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
  let lastIdx = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > lastIdx) out.push(text.slice(lastIdx, m.index));
    if (m[1] !== undefined) {
      out.push(
        <strong key={`${baseKey}-b-${k++}`} className="md-bold">
          {m[1]}
        </strong>,
      );
    } else if (m[2] !== undefined) {
      out.push(
        <code key={`${baseKey}-c-${k++}`} className="md-code">
          {m[2]}
        </code>,
      );
    }
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) out.push(text.slice(lastIdx));
  return out;
}
