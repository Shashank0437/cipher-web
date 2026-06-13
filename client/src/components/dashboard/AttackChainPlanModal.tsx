"use client";

import { Loader2, Target } from "lucide-react";
import { useEffect, useState } from "react";
import type { AttackChainPlan } from "@/lib/agentAttackChains";

type AttackChainPlanModalProps = {
  plan: AttackChainPlan | null;
  open: boolean;
  onClose: () => void;
  onStart: (target: string, note: string) => void | Promise<void>;
  starting?: boolean;
  error?: string | null;
};

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

  useEffect(() => {
    if (open && plan) {
      setTarget("");
      setNote("");
    }
  }, [open, plan?.id]);

  if (!open || !plan) return null;

  const canStart = target.trim().length > 0 && !starting;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="attack-chain-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-outline-variant/60 bg-surface-container-lowest shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-outline-variant/50 px-5 py-4">
          <h2 id="attack-chain-modal-title" className="text-lg font-bold text-on-surface">
            Start {plan.title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          <p className="text-[14px] leading-relaxed text-on-surface-variant">{plan.modal_description}</p>

          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant/80">Typical tooling</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {plan.tools.map((t) => (
                <span
                  key={t}
                  className="rounded-md border border-outline-variant/70 bg-surface-container-high/80 px-2 py-0.5 text-[12px] font-medium text-on-surface"
                >
                  {t}
                </span>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="attack-chain-target">
              Target <span className="text-error">*</span>
            </label>
            <input
              id="attack-chain-target"
              type="text"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder={plan.placeholder}
              className="mt-1.5 w-full rounded-xl border border-primary/40 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none ring-primary/20 focus:ring-2"
              disabled={starting}
            />
          </div>

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="attack-chain-note">
              Note (optional)
            </label>
            <textarea
              id="attack-chain-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Context for this run"
              rows={3}
              className="mt-1.5 w-full resize-none rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              disabled={starting}
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[13px] text-error">{error}</p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 border-t border-outline-variant/50 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={starting}
            className="rounded-xl px-4 py-2 text-[14px] font-semibold text-on-surface-variant hover:bg-surface-container-high"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={!canStart}
            onClick={() => void onStart(target.trim(), note.trim())}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-[14px] font-semibold text-on-primary shadow-sm disabled:opacity-50"
          >
            {starting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            Start Session
          </button>
        </div>
      </div>
    </div>
  );
}
