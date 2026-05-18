import type { Translator } from "./i18n";

export type Liveness = "live" | "recent" | "idle";

export type Thresholds = { liveMs: number; recentMs: number };

export function livenessOf(
  lastTs: number | undefined,
  now: number,
  t: Thresholds,
): Liveness {
  if (lastTs === undefined) return "idle";
  const dt = now - lastTs;
  if (dt < t.liveMs) return "live";
  if (dt < t.recentMs) return "recent";
  return "idle";
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = v >= 100 || i === 0 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function shortenCwd(cwd: string | null): string {
  if (!cwd) return "—";
  return cwd.replace(/^\/Users\/[^/]+/, "~");
}

export function cwdLabel(cwd: string | null, translate?: Translator): string {
  if (!cwd) return translate ? translate("dash.nocwd") : "(no cwd)";
  const stripped = cwd.replace(/^\/Users\/[^/]+\//, "");
  const parts = stripped.split("/").filter(Boolean);
  if (parts.length === 0) return stripped || cwd;
  if (parts.length <= 2) return parts.join("/");
  return parts.slice(-2).join("/");
}

export function formatRange(
  startIso: string,
  endIso: string,
  translate?: Translator,
): string {
  const start = new Date(startIso);
  const end = new Date(endIso);
  const now = new Date();
  const sameDay = start.toDateString() === end.toDateString();
  const isToday = end.toDateString() === now.toDateString();
  const isYesterday =
    end.toDateString() === new Date(now.getTime() - 24 * 3600 * 1000).toDateString();

  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
  const todayWord = translate ? translate("sessions.today") : "today";
  const yesterdayWord = translate ? translate("sessions.yesterday") : "yesterday";
  const dayPart = isToday
    ? todayWord
    : isYesterday
    ? yesterdayWord
    : start.toLocaleDateString();

  if (sameDay) return `${dayPart} ${fmt(start)} → ${fmt(end)}`;
  return `${start.toLocaleDateString()} ${fmt(start)} → ${end.toLocaleDateString()} ${fmt(end)}`;
}
