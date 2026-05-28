import { createContext, useContext } from "react";
import { type Lang, type Translator, makeTranslator } from "./i18n";
import type { Thresholds } from "./utils";
import type { ModelPrice } from "./pricing";

export type TabKey = "activity" | "dashboard" | "sessions" | "cost" | "policy";

export type RetentionDays = 7 | 30 | 90 | 0; // 0 = forever

export interface Settings {
  liveSeconds: number;
  recentMinutes: number;
  defaultTab: TabKey;
  defaultShowUsage: boolean;
  defaultAutoScroll: boolean;
  density: "comfortable" | "compact";
  reduceMotion: boolean;
  language: Lang;
  retentionDays: RetentionDays;
  // null = auto (pick the first detected terminal for the current OS).
  defaultTerminal: string | null;
  terminalProxyEnabled: boolean;
  // Stored as the user typed it; bare host:port is treated as http:// at launch.
  terminalProxyAddress: string;
  // Sparse per-model price overrides. Keys are normalized model strings; each
  // entry's fields fall back to DEFAULT_PRICES (and FALLBACK_PRICE for
  // unknown models) when not set. Empty for new users.
  customPricing: Record<string, Partial<ModelPrice>>;
}

export const DEFAULT_SETTINGS: Settings = {
  liveSeconds: 15,
  recentMinutes: 5,
  defaultTab: "activity",
  defaultShowUsage: false,
  defaultAutoScroll: true,
  density: "comfortable",
  reduceMotion: false,
  language: "zh",
  retentionDays: 30,
  defaultTerminal: null,
  terminalProxyEnabled: false,
  terminalProxyAddress: "127.0.0.1:7890",
  customPricing: {},
};

const SETTINGS_KEY = "agenthub.settings.v1";

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable — best-effort */
  }
}

export interface SettingsContextValue {
  settings: Settings;
  thresholds: Thresholds;
  update: (patch: Partial<Settings>) => void;
  reset: () => void;
  t: Translator;
}

export const SettingsContext = createContext<SettingsContextValue>({
  settings: DEFAULT_SETTINGS,
  thresholds: {
    liveMs: DEFAULT_SETTINGS.liveSeconds * 1000,
    recentMs: DEFAULT_SETTINGS.recentMinutes * 60_000,
  },
  update: () => {},
  reset: () => {},
  t: makeTranslator("en"),
});

export function useSettings() {
  return useContext(SettingsContext);
}
