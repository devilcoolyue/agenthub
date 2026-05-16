export type Agent = "claude-code" | "codex";

export type EventKind =
  | { type: "session_start"; model: string | null; version: string | null }
  | { type: "user_prompt"; text: string }
  | { type: "assistant_thinking" }
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; name: string; summary: string; raw_input: unknown }
  | { type: "tool_result"; ok: boolean; summary: string }
  | { type: "system"; text: string }
  | { type: "usage" }
  | { type: "other"; tag: string };

export interface Usage {
  model: string | null;
  input_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
  cost_micros: number;
}

export interface AgentEvent {
  agent: Agent;
  session_id: string;
  cwd: string | null;
  timestamp: string; // ISO-8601 UTC
  kind: EventKind;
  risk_tags: string[];
  usage?: Usage;
}

export interface SessionSummary {
  session_id: string;
  agent: string;          // "claude-code" | "codex" (kebab from backend)
  cwd: string | null;
  start_ts: string;
  end_ts: string;
  event_count: number;
  high_risk_count: number;
  tool_count: number;
}

export interface SessionCategory {
  cwd: string | null;
  session_count: number;
  high_risk_session_count: number;
  event_count: number;
}

export interface SessionsFilter {
  cwd?: string | null;
  query?: string | null;
  high_risk_only?: boolean;
}

export interface DailyCost {
  day: string;             // YYYY-MM-DD
  agent: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

export interface ModelCost {
  model: string;
  input_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  output_tokens: number;
  cost_micros: number;
}

export function fmtUSD(micros: number): string {
  const dollars = micros / 1_000_000;
  if (dollars >= 1000) return "$" + dollars.toFixed(0);
  if (dollars >= 10) return "$" + dollars.toFixed(2);
  if (dollars >= 0.01) return "$" + dollars.toFixed(2);
  if (dollars > 0) return "$" + dollars.toFixed(4);
  return "$0";
}

export type RemoveAction =
  | { kind: "claude_permission_allow"; rule: string; file: string }
  | { kind: "codex_trusted_project"; path: string }
  | { kind: "codex_model_provider"; name: string }
  | {
      kind: "claude_hook";
      event: string;
      group_index: number;
      hook_index: number;
      file: string;
    };

export interface BatchResult {
  removed: number;
  failed: string[];
}

export interface BackupInfo {
  backup_path: string;
  original_path: string;
  timestamp: string;
  size_bytes: number;
}

export interface PolicyItem {
  category:
    | "permission"
    | "trusted-project"
    | "model-provider"
    | "mcp-server"
    | "hook"
    | "info";
  label: string;
  detail: string | null;
  risk_tags: string[];
  source_path: string;
  remove_action: RemoveAction | null;
}

export interface AgentPolicy {
  agent: string;
  model: string | null;
  config_files: string[];
  items: PolicyItem[];
  high_risk_count: number;
}

export type BackfillProgress =
  | { phase: "started" }
  | { phase: "hashes_migrated"; migrated: number }
  | { phase: "scanning"; scanned: number; inserted: number }
  | { phase: "done"; scanned: number; inserted: number; hashes_migrated: number }
  | { phase: "failed"; error: string };

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toString();
}

export type RiskLevel = "low" | "med" | "high";

export function riskLevel(tags: string[]): RiskLevel {
  if (tags.some((t) => t === "shell-dangerous" || t === "secret-path")) return "high";
  if (tags.some((t) => t === "network")) return "med";
  return "low";
}

// Weights (points per occurrence) and per-category caps so a flood of one tag
// can't bury the score on its own.
const RISK_WEIGHTS: Record<string, { weight: number; cap: number }> = {
  "shell-dangerous": { weight: 10, cap: 40 },
  "secret-path":     { weight: 8,  cap: 30 },
  "network":         { weight: 2,  cap: 20 },
};

export interface RiskSummary {
  score: number;            // 0-100
  level: RiskLevel;
  findings: { tag: string; count: number; latest: AgentEvent }[];
  windowSize: number;       // how many events the score considered
}

export function computeRiskSummary(events: AgentEvent[], windowSize = 200): RiskSummary {
  const slice = events.slice(-windowSize);
  const counts = new Map<string, { count: number; latest: AgentEvent }>();
  for (const e of slice) {
    for (const tag of e.risk_tags) {
      const prev = counts.get(tag);
      if (!prev) counts.set(tag, { count: 1, latest: e });
      else counts.set(tag, { count: prev.count + 1, latest: e });
    }
  }
  let score = 0;
  for (const [tag, { count }] of counts) {
    const cfg = RISK_WEIGHTS[tag];
    if (!cfg) continue;
    score += Math.min(count * cfg.weight, cfg.cap);
  }
  score = Math.min(100, Math.round(score));
  const level: RiskLevel = score >= 50 ? "high" : score >= 20 ? "med" : "low";
  const findings = Array.from(counts.entries())
    .map(([tag, v]) => ({ tag, count: v.count, latest: v.latest }))
    .sort((a, b) => (RISK_WEIGHTS[b.tag]?.weight ?? 0) - (RISK_WEIGHTS[a.tag]?.weight ?? 0)
                  || b.count - a.count);
  return { score, level, findings, windowSize: slice.length };
}
