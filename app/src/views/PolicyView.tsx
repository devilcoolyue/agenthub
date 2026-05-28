import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  AgentPolicy,
  BackupInfo,
  BatchResult,
  PolicyItem,
} from "../types";
import { useSettings } from "../settings";
import { basename, homeifyPath } from "../utils";
import "./PolicyView.css";

interface PendingBatch {
  items: PolicyItem[];
  label: string; // descriptive title for the modal
}

export function PolicyView() {
  const { t } = useSettings();
  const [policies, setPolicies] = useState<AgentPolicy[] | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingBatch | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const reload = useCallback(async () => {
    const [pol, bks] = await Promise.all([
      invoke<AgentPolicy[]>("get_agent_policies"),
      invoke<BackupInfo[]>("list_policy_backups", { limit: 20 }),
    ]);
    setPolicies(pol);
    setBackups(bks);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const requestRemove = (item: PolicyItem) => {
    if (!item.remove_action) return;
    setConfirming({
      items: [item],
      label: t("policy.removeSingle", {
        category: t(`policy.catName.${item.category}`),
      }),
    });
  };

  const requestBatch = (items: PolicyItem[], description: string) => {
    const filtered = items.filter((i) => i.remove_action);
    if (filtered.length === 0) return;
    setConfirming({ items: filtered, label: description });
  };

  const doRemove = async () => {
    const batch = confirming;
    if (!batch) return;
    setConfirming(null);
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      if (batch.items.length === 1) {
        await invoke("remove_policy_item", { action: batch.items[0].remove_action });
        setSuccess(t("policy.removed1"));
      } else {
        const actions = batch.items.map((i) => i.remove_action);
        const result = await invoke<BatchResult>("remove_policy_items", { actions });
        if (result.failed.length > 0) {
          setError(
            t("policy.removedFailed", {
              n: result.removed,
              list: result.failed.join("\n"),
            }),
          );
        } else {
          setSuccess(t("policy.removedN", { n: result.removed }));
        }
      }
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  const doRestore = async (b: BackupInfo) => {
    if (
      !window.confirm
    ) {
      // window.confirm unreliable in Tauri; use a simpler inline confirm
    }
    setPending(true);
    setError(null);
    setSuccess(null);
    try {
      await invoke("restore_policy_backup", {
        backupPath: b.backup_path,
        originalPath: b.original_path,
      });
      setSuccess(t("policy.restored", { file: basename(b.original_path) }));
      await reload();
    } catch (e) {
      setError(String(e));
    } finally {
      setPending(false);
      setTimeout(() => setSuccess(null), 3000);
    }
  };

  if (policies === null) return <div className="empty">{t("policy.loading")}</div>;
  if (policies.length === 0)
    return <div className="empty">{t("policy.empty")}</div>;

  return (
    <div className="policy-view">
      {error && <div className="policy-error">{error}</div>}
      {success && <div className="policy-success">{success}</div>}

      {backups.length > 0 && (
        <details
          className="history-panel"
          open={historyOpen}
          onToggle={(e) => setHistoryOpen((e.target as HTMLDetailsElement).open)}
        >
          <summary>
            {t("policy.history")}
            <span className="history-count">{backups.length}</span>
            <span className="history-hint">{t("policy.history.hint")}</span>
          </summary>
          <ul className="history-list">
            {backups.map((b) => (
              <li key={b.backup_path} className="history-row">
                <div className="hr-main">
                  <div className="hr-file">
                    {homeifyPath(b.original_path)}
                  </div>
                  <div className="hr-meta">
                    {new Date(b.timestamp).toLocaleString()} ·{" "}
                    {(b.size_bytes / 1024).toFixed(1)} KB
                  </div>
                </div>
                <button
                  className="btn-secondary"
                  onClick={() => doRestore(b)}
                  disabled={pending}
                  title={b.backup_path}
                >
                  {t("policy.history.restore")}
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}

      {policies.map((p) => (
        <PolicyCard
          key={p.agent}
          p={p}
          pending={pending}
          onRemove={requestRemove}
          onBatch={requestBatch}
        />
      ))}
      {confirming && (
        <ConfirmRemoveModal
          batch={confirming}
          onCancel={() => setConfirming(null)}
          onConfirm={doRemove}
        />
      )}
    </div>
  );
}

function ConfirmRemoveModal({
  batch,
  onCancel,
  onConfirm,
}: {
  batch: PendingBatch;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useSettings();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  const previewLimit = 8;
  const preview = batch.items.slice(0, previewLimit);
  const filesAffected = Array.from(
    new Set(batch.items.map((i) => i.source_path)),
  );

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">
          {batch.label}{" "}
          <span className="modal-count">({batch.items.length})</span>
        </div>
        <pre className="modal-target">
          {preview.map((it) => it.label).join("\n")}
          {batch.items.length > previewLimit && (
            <>
              {"\n"}
              {t("policy.modal.andMore", { n: batch.items.length - previewLimit })}
            </>
          )}
        </pre>
        <div className="modal-detail">
          {filesAffected.length === 1
            ? t("policy.modal.affectsOne", {
                file: homeifyPath(filesAffected[0]),
              })
            : t("policy.modal.affectsMany", { n: filesAffected.length })}
        </div>
        <div className="modal-note">{t("policy.modal.note")}</div>
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            {t("policy.modal.cancel")}
          </button>
          <button className="btn-danger" onClick={onConfirm} autoFocus>
            {t("policy.modal.remove", { n: batch.items.length })}
          </button>
        </div>
      </div>
    </div>
  );
}

function PolicyCard({
  p,
  pending,
  onRemove,
  onBatch,
}: {
  p: AgentPolicy;
  pending: boolean;
  onRemove: (item: PolicyItem) => void;
  onBatch: (items: PolicyItem[], description: string) => void;
}) {
  const { t } = useSettings();
  // Group items by category for display
  const groups = new Map<string, PolicyItem[]>();
  for (const it of p.items) {
    const arr = groups.get(it.category) ?? [];
    arr.push(it);
    groups.set(it.category, arr);
  }
  const order: PolicyItem["category"][] = [
    "permission",
    "model-provider",
    "trusted-project",
    "mcp-server",
    "rule",
    "hook",
    "info",
  ];
  return (
    <div className={`policy-card ${p.high_risk_count > 0 ? "has-risk" : ""}`}>
      <div className="policy-card-head">
        <span className={`agent agent-${p.agent}`}>{p.agent}</span>
        {p.model && <span className="policy-model">{p.model}</span>}
        <span className="policy-files" title={p.config_files.join("\n")}>
          {t(
            p.config_files.length === 1 ? "policy.configFile" : "policy.configFiles",
            { n: p.config_files.length },
          )}
        </span>
        {p.high_risk_count > 0 && (
          <span className="policy-risk-pill">
            {t("policy.flaggedPill", { n: p.high_risk_count })}
          </span>
        )}
      </div>

      {order.map((cat) => {
        const items = groups.get(cat);
        if (!items || items.length === 0) return null;
        const title = t(`policy.cat.${cat}`);
        const flagged = items.filter((i) => i.risk_tags.length > 0).length;

        // Bucket items by each risk tag they carry → support "remove all with tag X"
        const tagBuckets = new Map<string, PolicyItem[]>();
        for (const it of items) {
          for (const tag of it.risk_tags) {
            const arr = tagBuckets.get(tag) ?? [];
            arr.push(it);
            tagBuckets.set(tag, arr);
          }
        }
        const bulkTags = Array.from(tagBuckets.entries())
          .filter(([, arr]) => arr.length >= 2 && arr.some((x) => x.remove_action))
          .sort((a, b) => b[1].length - a[1].length);

        return (
          <section className="policy-section" key={cat}>
            <header className="policy-section-head">
              <span className="ps-title">{title}</span>
              <span className="ps-count">
                {items.length}
                {flagged > 0 && (
                  <span className="ps-flagged">
                    {" · "}
                    {t("policy.flaggedSep", { n: flagged })}
                  </span>
                )}
              </span>
            </header>
            {bulkTags.length > 0 && (
              <div className="bulk-actions">
                {bulkTags.map(([tag, arr]) => (
                  <button
                    key={tag}
                    className={`bulk-btn tag-${tag}`}
                    disabled={pending}
                    onClick={() =>
                      onBatch(
                        arr,
                        t("policy.removeBulkLabel", { n: arr.length, tag }),
                      )
                    }
                  >
                    {t("policy.removeBulkBtn", { n: arr.length })} <code>{tag}</code>
                  </button>
                ))}
              </div>
            )}
            <ul className="policy-items">
              {items.map((it, i) => (
                <PolicyRow
                  key={`${cat}-${i}`}
                  it={it}
                  pending={pending}
                  onRemove={() => onRemove(it)}
                />
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function PolicyRow({
  it,
  pending,
  onRemove,
}: {
  it: PolicyItem;
  pending: boolean; // any policy op is in-flight
  onRemove: () => void;
}) {
  const { t } = useSettings();
  const high = it.risk_tags.length > 0;
  return (
    <li className={`policy-item ${high ? "flagged" : ""}`}>
      <div className="pi-main">
        <div className="pi-label" title={it.label}>{it.label}</div>
        {it.detail && <div className="pi-detail">{it.detail}</div>}
        {it.risk_tags.length > 0 && (
          <div className="pi-tags">
            {it.risk_tags.map((tag) => (
              <span key={tag} className={`pi-tag tag-${tag}`}>
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
      {it.remove_action && (
        <button
          className="pi-remove"
          onClick={onRemove}
          disabled={pending}
        >
          {pending ? "…" : t("policy.remove")}
        </button>
      )}
    </li>
  );
}
