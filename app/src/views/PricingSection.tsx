import { useEffect, useMemo, useState } from "react";
import {
  DEFAULT_PRICES,
  knownModelKeys,
  normalizeModelKey,
  priceFor,
  type ModelPrice,
} from "../pricing";
import { useSettings } from "../settings";

/** Convert internal micros-per-MTok to a USD string for display. Up to 4
 *  decimal places (so $0.075 / $0.02 / $0.175 etc. round-trip cleanly), with
 *  trailing zeros stripped. */
function microsToUsdStr(m: number): string {
  if (!isFinite(m)) return "0";
  const v = m / 1_000_000;
  const fixed = v.toFixed(4);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function usdToMicros(s: string): number | null {
  const n = parseFloat(s);
  if (!isFinite(n) || n < 0) return null;
  return Math.round(n * 1_000_000);
}

type Vendor = "anthropic" | "openai" | "other";

function vendorOf(model: string): Vendor {
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3"))
    return "openai";
  return "other";
}

/** Shallow equality across the two-level shape `Record<string, Partial<ModelPrice>>`.
 *  Used to detect whether the draft has unsaved differences vs. settings. */
function pricingOverridesEqual(
  a: Record<string, Partial<ModelPrice>>,
  b: Record<string, Partial<ModelPrice>>,
): boolean {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  const fields: (keyof ModelPrice)[] = ["input", "cacheCreate", "cacheRead", "output"];
  for (const k of ak) {
    const av = a[k];
    const bv = b[k];
    if (!bv) return false;
    for (const f of fields) {
      if (av[f] !== bv[f]) return false;
    }
  }
  return true;
}

export function PricingSection() {
  const { settings, update, t } = useSettings();
  const saved = settings.customPricing;
  const [draft, setDraft] = useState<Record<string, Partial<ModelPrice>>>(saved);
  // Sync if settings change externally (e.g. another window or a `reset()`).
  // The local draft becomes the source of truth as soon as the user edits.
  useEffect(() => {
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saved]);

  const [resetAllConfirming, setResetAllConfirming] = useState(false);
  const [vendorOpenOverride, setVendorOpenOverride] = useState<
    Partial<Record<Vendor, boolean>>
  >({});

  const isDirty = !pricingOverridesEqual(draft, saved);
  const hasDraftOverrides = Object.keys(draft).length > 0;

  const setField = (model: string, field: keyof ModelPrice, raw: string) => {
    const micros = usdToMicros(raw);
    if (micros === null) return;
    const cur = draft[model] ?? {};
    const defaultPrice = DEFAULT_PRICES[normalizeModelKey(model)];
    // If the new value equals the default AND there's a saved DEFAULT_PRICES
    // entry for this model, drop the override for that field. For custom
    // models (no default entry), always keep the explicit value.
    const next: Partial<ModelPrice> = { ...cur };
    if (defaultPrice && defaultPrice[field] === micros) {
      delete next[field];
    } else {
      next[field] = micros;
    }
    const nextDraft = { ...draft };
    // Custom models (not in DEFAULT_PRICES) keep their key even with empty {}
    // so the row stays visible. Known models with all-default values get
    // removed entirely.
    if (Object.keys(next).length === 0 && DEFAULT_PRICES[normalizeModelKey(model)]) {
      delete nextDraft[model];
    } else {
      nextDraft[model] = next;
    }
    setDraft(nextDraft);
  };

  const resetRow = (model: string) => {
    if (!draft[model]) return;
    const next = { ...draft };
    delete next[model];
    setDraft(next);
  };

  const save = () => {
    update({ customPricing: draft });
  };
  const discard = () => {
    setDraft(saved);
  };
  const resetAll = () => {
    if (!resetAllConfirming) {
      setResetAllConfirming(true);
      window.setTimeout(() => setResetAllConfirming(false), 4000);
      return;
    }
    setResetAllConfirming(false);
    setDraft({});
  };

  const addCustom = (name: string): { ok: true } | { ok: false; reasonKey: string } => {
    const trimmed = name.trim();
    if (!trimmed) return { ok: false, reasonKey: "set.pricing.addCustom.err.empty" };
    const norm = normalizeModelKey(trimmed);
    if (DEFAULT_PRICES[norm] || DEFAULT_PRICES[trimmed] || draft[trimmed] || draft[norm]) {
      return { ok: false, reasonKey: "set.pricing.addCustom.err.dup" };
    }
    // Empty override entry — `priceFor` falls back to FALLBACK_PRICE for
    // display, and the row appears under `knownModelKeys`. Edits add fields
    // to this entry; Remove deletes it.
    setDraft({ ...draft, [trimmed]: {} });
    // Force the vendor group containing this model open so the user sees the
    // new row immediately.
    setVendorOpenOverride((v) => ({ ...v, [vendorOf(trimmed)]: true }));
    return { ok: true };
  };

  const keys = useMemo(() => knownModelKeys(draft), [draft]);
  const grouped = useMemo(() => {
    const out: Record<Vendor, string[]> = { anthropic: [], openai: [], other: [] };
    for (const k of keys) out[vendorOf(k)].push(k);
    return out;
  }, [keys]);

  const sections: { vendor: Vendor; labelKey: string }[] = [
    { vendor: "anthropic", labelKey: "set.pricing.vendor.anthropic" },
    { vendor: "openai", labelKey: "set.pricing.vendor.openai" },
    { vendor: "other", labelKey: "set.pricing.vendor.other" },
  ];

  return (
    <div className="settings-section">
      <div className="settings-section-header">
        <div className="settings-section-title">{t("set.section.pricing")}</div>
        <div className="pricing-actions">
          {hasDraftOverrides && (
            <button
              type="button"
              className="pricing-reset-all"
              onClick={resetAll}
            >
              {resetAllConfirming
                ? t("set.pricing.resetAll.confirm")
                : t("set.pricing.resetAll")}
            </button>
          )}
          {isDirty && (
            <button
              type="button"
              className="pricing-discard"
              onClick={discard}
            >
              {t("set.pricing.discard")}
            </button>
          )}
          <button
            type="button"
            className={`pricing-save ${isDirty ? "active" : ""}`}
            onClick={save}
            disabled={!isDirty}
          >
            {t("set.pricing.save")}
          </button>
        </div>
      </div>
      <div className="settings-section-hint">{t("set.pricing.hint")}</div>
      {isDirty && (
        <div className="pricing-unsaved-banner">
          {t("set.pricing.unsavedBanner")}
        </div>
      )}
      <div className="pricing-groups">
        {sections.map(({ vendor, labelKey }) => {
          const models = grouped[vendor];
          if (models.length === 0) return null;
          const draftEditedCount = models.filter(
            (m) => (draft[normalizeModelKey(m)] ?? draft[m]) !== undefined,
          ).length;
          // Auto-expand if vendor has any draft entries (saved or unsaved), so
          // user lands on the relevant rows. Once user toggles manually, that
          // choice persists for the session via vendorOpenOverride.
          const open =
            vendorOpenOverride[vendor] ??
            (draftEditedCount > 0);
          return (
            <PricingVendorGroup
              key={vendor}
              label={t(labelKey)}
              models={models}
              countLabel={t("set.pricing.vendor.count", { models: String(models.length) })}
              editedLabel={
                draftEditedCount > 0
                  ? t("set.pricing.vendor.editedCount", { n: String(draftEditedCount) })
                  : null
              }
              open={open}
              onToggle={(o) =>
                setVendorOpenOverride((v) => ({ ...v, [vendor]: o }))
              }
              draft={draft}
              saved={saved}
              onChange={setField}
              onReset={resetRow}
            />
          );
        })}
      </div>
      <PricingAddCustomForm onAdd={addCustom} />
    </div>
  );
}

function PricingVendorGroup({
  label,
  models,
  countLabel,
  editedLabel,
  open,
  onToggle,
  draft,
  saved,
  onChange,
  onReset,
}: {
  label: string;
  models: string[];
  countLabel: string;
  editedLabel: string | null;
  open: boolean;
  onToggle: (open: boolean) => void;
  draft: Record<string, Partial<ModelPrice>>;
  saved: Record<string, Partial<ModelPrice>>;
  onChange: (model: string, field: keyof ModelPrice, raw: string) => void;
  onReset: (model: string) => void;
}) {
  const { t } = useSettings();
  return (
    <details
      className="pricing-group"
      open={open}
      onToggle={(e) => onToggle((e.target as HTMLDetailsElement).open)}
    >
      <summary className="pricing-group-summary">
        <span className="pricing-group-caret" aria-hidden>▸</span>
        <span className="pricing-group-label">{label}</span>
        <span className="pricing-group-count">{countLabel}</span>
        {editedLabel && <span className="pricing-group-edited">{editedLabel}</span>}
      </summary>
      <div className="pricing-table-wrap">
        <table className="pricing-table">
          <thead>
            <tr>
              <th>{t("set.pricing.col.model")}</th>
              <th className="num">{t("set.pricing.col.input")}</th>
              <th className="num">{t("set.pricing.col.cacheCreate")}</th>
              <th className="num">{t("set.pricing.col.cacheRead")}</th>
              <th className="num">{t("set.pricing.col.output")}</th>
              <th className="pricing-reset-col" />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <PricingRow
                key={model}
                model={model}
                draft={draft}
                saved={saved}
                onChange={onChange}
                onReset={onReset}
              />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function PricingRow({
  model,
  draft,
  saved,
  onChange,
  onReset,
}: {
  model: string;
  draft: Record<string, Partial<ModelPrice>>;
  saved: Record<string, Partial<ModelPrice>>;
  onChange: (model: string, field: keyof ModelPrice, raw: string) => void;
  onReset: (model: string) => void;
}) {
  const { t } = useSettings();
  const norm = normalizeModelKey(model);
  const draftOv = draft[norm] ?? draft[model];
  const savedOv = saved[norm] ?? saved[model];
  const isCustom = !DEFAULT_PRICES[norm] && !DEFAULT_PRICES[model];

  const draftPrice = priceFor(model, draft);
  const savedPrice = priceFor(model, saved);

  const fields: (keyof ModelPrice)[] = ["input", "cacheCreate", "cacheRead", "output"];

  // Per-input raw text buffer. While the user is mid-typing, we keep the
  // exact string they entered (including `"1."`, `""`, etc.) instead of
  // round-tripping through parseFloat — otherwise the trailing dot or the
  // empty-after-backspace state gets eaten and they can't enter decimals or
  // clear a digit. The buffer is dropped on blur, so the field re-derives
  // from the committed numeric value.
  const [raw, setRaw] = useState<Partial<Record<keyof ModelPrice, string>>>({});

  const displayFor = (f: keyof ModelPrice) =>
    raw[f] !== undefined ? raw[f]! : microsToUsdStr(draftPrice[f]);

  const handleInput = (f: keyof ModelPrice, next: string) => {
    setRaw((prev) => ({ ...prev, [f]: next }));
    // Only commit when the string parses to a non-negative number. Partial
    // states like "1." parse to 1 and commit fine; "" / "abc" don't commit,
    // and the draft retains its previous value.
    const micros = usdToMicros(next);
    if (micros !== null) {
      onChange(model, f, next);
    }
  };

  const handleBlur = (f: keyof ModelPrice) => {
    setRaw((prev) => {
      if (prev[f] === undefined) return prev;
      const { [f]: _drop, ...rest } = prev;
      void _drop;
      return rest;
    });
  };

  const rowDirty = fields.some((f) => draftPrice[f] !== savedPrice[f])
    || (!!draftOv) !== (!!savedOv);
  const hasSavedOverride = !!savedOv && Object.keys(savedOv).length > 0;
  const hasDraftOverride = !!draftOv && Object.keys(draftOv).length > 0;
  const showResetBtn = isCustom || hasDraftOverride;

  let tag: { label: string; cls: string } | null = null;
  if (rowDirty) tag = { label: t("set.pricing.unsaved"), cls: "unsaved" };
  else if (hasSavedOverride) tag = { label: t("set.pricing.overridden"), cls: "overridden" };

  return (
    <tr className={`pricing-row ${rowDirty ? "dirty" : hasSavedOverride ? "overridden" : ""}`}>
      <td className="pricing-model">
        <span className="pricing-model-name">{model}</span>
        {tag && <span className={`pricing-edited-tag ${tag.cls}`}>{tag.label}</span>}
      </td>
      {fields.map((field) => {
        const fieldDirty = draftPrice[field] !== savedPrice[field];
        const fieldHasOverride = !!draftOv && draftOv[field] !== undefined;
        return (
          <td key={field} className="num">
            <input
              className={`pricing-input ${fieldDirty ? "dirty" : fieldHasOverride ? "overridden" : ""}`}
              type="text"
              inputMode="decimal"
              value={displayFor(field)}
              onChange={(e) => handleInput(field, e.target.value)}
              onBlur={() => handleBlur(field)}
              aria-label={`${model} ${field}`}
              spellCheck={false}
            />
          </td>
        );
      })}
      <td className="pricing-reset-col">
        {showResetBtn && (
          <button
            type="button"
            className="pricing-reset-row"
            onClick={() => onReset(model)}
            title={isCustom ? t("set.pricing.removeRow.title") : t("set.pricing.resetRow.title")}
          >
            {isCustom ? t("set.pricing.removeRow") : t("set.pricing.resetRow")}
          </button>
        )}
      </td>
    </tr>
  );
}

function PricingAddCustomForm({
  onAdd,
}: {
  onAdd: (name: string) => { ok: true } | { ok: false; reasonKey: string };
}) {
  const { t } = useSettings();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const submit = () => {
    const r = onAdd(name);
    if (r.ok) {
      setName("");
      setOpen(false);
      setErr(null);
    } else {
      setErr(t(r.reasonKey));
    }
  };
  if (!open) {
    return (
      <button
        type="button"
        className="pricing-add-btn"
        onClick={() => {
          setOpen(true);
          setErr(null);
        }}
      >
        {t("set.pricing.addCustom")}
      </button>
    );
  }
  return (
    <div className="pricing-add-form">
      <input
        type="text"
        className="pricing-add-input"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (err) setErr(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") submit();
          if (e.key === "Escape") {
            setOpen(false);
            setName("");
            setErr(null);
          }
        }}
        placeholder={t("set.pricing.addCustom.placeholder")}
        spellCheck={false}
        autoFocus
      />
      <button type="button" className="pricing-add-confirm" onClick={submit}>
        {t("set.pricing.addCustom.confirm")}
      </button>
      <button
        type="button"
        className="pricing-add-cancel"
        onClick={() => {
          setOpen(false);
          setName("");
          setErr(null);
        }}
      >
        {t("set.pricing.addCustom.cancel")}
      </button>
      {err && <span className="pricing-add-err">{err}</span>}
    </div>
  );
}
