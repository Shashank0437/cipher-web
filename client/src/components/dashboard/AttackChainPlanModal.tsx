"use client";

import { Loader2, Route, Sparkles, Target } from "lucide-react";
import { useEffect, useState } from "react";
import {
  previewAttackChainPlan,
  stepSelectionReason,
  type AttackChainPlan,
  type AttackChainPlanPreview,
  type AttackChainPrecision,
} from "@/lib/agentAttackChains";

type AttackChainPlanModalProps = {
  plan: AttackChainPlan | null;
  open: boolean;
  onClose: () => void;
  onStart: (target: string, note: string, preview: AttackChainPlanPreview) => void | Promise<void>;
  starting?: boolean;
  error?: string | null;
};

const PRECISION_OPTIONS: { value: AttackChainPrecision; label: string }[] = [
  { value: "quick", label: "Quick (faster, narrower coverage)" },
  { value: "comprehensive", label: "Comprehensive (safer coverage)" },
  { value: "stealth", label: "Stealth (lower noise)" },
];

function fmtPercent(n?: number | null) {
  return typeof n === "number" ? `${Math.round(n * 100)}%` : "n/a";
}

export function AttackChainPlanModal({
  plan,
  open,
  onClose,
  onStart,
  starting = false,
  error,
}: AttackChainPlanModalProps) {
  const [target, setTarget] = useState("");
  const [note, setNote] = useState("");
  const [precision, setPrecision] = useState<AttackChainPrecision>("comprehensive");
  const [preview, setPreview] = useState<AttackChainPlanPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const isIntelligent = plan?.kind === "intelligent" || plan?.id === "intelligent_attack_chain";

  useEffect(() => {
    if (open && plan) {
      setTarget("");
      setNote("");
      setPrecision("comprehensive");
      setPreview(null);
      setPreviewError(null);
      setPreviewing(false);
    }
  }, [open, plan?.id]);

  if (!open || !plan) return null;

  const busy = starting || previewing;
  const canPreview = target.trim().length > 0 && !busy;
  const canStartFixed = target.trim().length > 0 && !busy;
  const canStartIntelligent = preview?.success && preview.steps.length > 0 && !busy;

  async function handlePreview() {
    if (!canPreview || !plan) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await previewAttackChainPlan(plan.id, target.trim(), {
        objective: precision,
        operatorNote: note,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Preview failed");
      }
      setPreview(result);
    } catch (err) {
      setPreview(null);
      setPreviewError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setPreviewing(false);
    }
  }

  async function handleStartFixed() {
    if (!canStartFixed || !plan) return;
    setPreviewing(true);
    setPreviewError(null);
    try {
      const result = await previewAttackChainPlan(plan.id, target.trim(), {
        objective: precision,
        operatorNote: note,
      });
      if (!result.success) {
        throw new Error(result.error ?? "Failed to build plan");
      }
      await onStart(target.trim(), note.trim(), result);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : "Failed to start");
    } finally {
      setPreviewing(false);
    }
  }

  const previewTools = preview ? Array.from(new Set(preview.tools)) : [];
  const displayError = error ?? previewError;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attack-chain-modal-title"
      onClick={onClose}
    >
      <div
        className={`w-full rounded-2xl border border-outline-variant/60 bg-surface-container-lowest shadow-2xl ${
          isIntelligent && preview ? "max-w-2xl" : "max-w-lg"
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-outline-variant/50 px-5 py-4">
          <div className="flex items-center gap-2">
            {isIntelligent ? <Sparkles className="h-5 w-5 text-primary" aria-hidden /> : null}
            <h2 id="attack-chain-modal-title" className="text-lg font-bold text-on-surface">
              {isIntelligent ? "Intelligent Attack Chain" : `Start ${plan.title}`}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="max-h-[min(70vh,640px)] space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[14px] leading-relaxed text-on-surface-variant">{plan.modal_description}</p>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant/80">Typical tooling</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {isIntelligent && !preview ? (
                <span className="rounded-md border border-outline-variant/70 bg-surface-container-high/80 px-2 py-0.5 text-[12px] font-medium text-on-surface-variant">
                  none preloaded — AI selects after analysis
                </span>
              ) : null}
              {(preview ? previewTools : plan.tools).map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-outline-variant/70 bg-surface-container-high/80 px-2 py-0.5 text-[12px] font-medium text-on-surface"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>

          {isIntelligent ? (
            <div>
              <label className="text-[13px] font-semibold text-on-surface" htmlFor="attack-chain-precision">
                Precision
              </label>
              <select
                id="attack-chain-precision"
                value={precision}
                onChange={(e) => {
                  setPrecision(e.target.value as AttackChainPrecision);
                  setPreview(null);
                }}
                disabled={busy}
                className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              >
                {PRECISION_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="attack-chain-target">
              Target <span className="text-error">*</span>
            </label>
            <input
              id="attack-chain-target"
              type="text"
              value={target}
              onChange={(e) => {
                setTarget(e.target.value);
                if (isIntelligent) setPreview(null);
              }}
              placeholder={plan.placeholder}
              className="mt-1.5 w-full rounded-xl border border-primary/40 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none ring-primary/20 focus:ring-2"
              disabled={busy}
            />
          </div>

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="attack-chain-note">
              {isIntelligent ? "Custom prompt (optional)" : "Note (optional)"}
            </label>
            <textarea
              id="attack-chain-note"
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                if (isIntelligent) setPreview(null);
              }}
              placeholder={
                isIntelligent
                  ? "Scope, constraints, or focus areas for the intelligence planner"
                  : "Context for this run"
              }
              rows={3}
              className="mt-1.5 w-full resize-none rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              disabled={busy}
            />
          </div>

          {isIntelligent && preview?.success ? (
            <div className="rounded-xl border border-primary/25 bg-primary-container/25 p-4 space-y-3">
              <p className="text-[13px] font-bold text-on-surface">Preview — review before starting</p>
              <div className="grid gap-1 text-[13px] text-on-surface-variant sm:grid-cols-2">
                <p><span className="font-semibold text-on-surface">Objective:</span> {preview.objective ?? precision}</p>
                <p><span className="font-semibold text-on-surface">Steps:</span> {preview.steps.length}</p>
                <p><span className="font-semibold text-on-surface">Tools:</span> {previewTools.length}</p>
                <p><span className="font-semibold text-on-surface">Risk:</span> {preview.risk_level ?? "unknown"}</p>
                <p><span className="font-semibold text-on-surface">Est. time:</span> {preview.estimated_time ?? 0}s</p>
                {preview.target_type ? (
                  <p><span className="font-semibold text-on-surface">Target type:</span> {preview.target_type}</p>
                ) : null}
              </div>
              <ol className="space-y-2 text-[13px]">
                {preview.steps.map((step, idx) => {
                  const tool = String(step.tool ?? "");
                  const reason = stepSelectionReason(step);
                  return (
                    <li key={`${tool}-${idx}`} className="rounded-lg border border-outline-variant/50 bg-surface-container-lowest/80 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-semibold text-on-surface">{idx + 1}. {tool}</span>
                        {reason?.effective_score != null ? (
                          <span className="rounded-md bg-surface-container-high px-1.5 py-0.5 text-[11px] text-on-surface-variant">
                            {fmtPercent(reason.effective_score)} match
                          </span>
                        ) : null}
                      </div>
                      {reason?.summary ? (
                        <p className="mt-1 text-[12px] leading-snug text-on-surface-variant">{reason.summary}</p>
                      ) : null}
                    </li>
                  );
                })}
              </ol>
            </div>
          ) : null}

          {displayError ? (
            <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[13px] text-error">{displayError}</p>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-outline-variant/50 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-xl px-4 py-2 text-[14px] font-semibold text-on-surface-variant hover:bg-surface-container-high"
          >
            Cancel
          </button>
          {isIntelligent ? (
            <>
              <button
                type="button"
                disabled={!canPreview}
                onClick={() => void handlePreview()}
                className="inline-flex items-center gap-2 rounded-xl border border-primary/35 bg-primary-container/40 px-4 py-2 text-[14px] font-semibold text-primary disabled:opacity-50"
              >
                {previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Route className="h-4 w-4" />}
                Preview Attack Chain
              </button>
              <button
                type="button"
                disabled={!canStartIntelligent}
                onClick={() => preview && void onStart(target.trim(), note.trim(), preview)}
                className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-on-primary shadow-sm disabled:opacity-50"
              >
                {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
                Start Session
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={!canStartFixed}
              onClick={() => void handleStartFixed()}
              className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-on-primary shadow-sm disabled:opacity-50"
            >
              {starting || previewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
              Start Session
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
