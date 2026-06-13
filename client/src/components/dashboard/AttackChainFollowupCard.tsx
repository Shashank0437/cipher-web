"use client";

import { Loader2, Sparkles } from "lucide-react";
import type { AttackChainFollowupPreview } from "@/lib/agentAttackChains";

type AttackChainFollowupCardProps = {
  preview: AttackChainFollowupPreview;
  loading?: boolean;
  onContinue: () => void | Promise<void>;
  onDismiss: () => void;
};

export function AttackChainFollowupCard({
  preview,
  loading = false,
  onContinue,
  onDismiss,
}: AttackChainFollowupCardProps) {
  const tools = preview.tools ?? [];
  const hasSteps = preview.steps.length > 0;

  return (
    <div
      className="rounded-xl border border-primary/30 bg-primary-container/30 px-4 py-3 shadow-sm"
      role="region"
      aria-label="AI follow-up suggestion"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" aria-hidden />
        <p className="text-[13px] font-bold text-on-surface">AI follow-up suggested</p>
        {preview.planner_source ? (
          <span className="rounded-md bg-primary/15 px-2 py-0.5 text-[11px] font-semibold text-primary">
            {preview.planner_source === "llm" ? "AI-planned" : preview.planner_source}
          </span>
        ) : null}
      </div>

      {preview.executive_summary ? (
        <p className="mt-2 text-[13px] leading-relaxed text-on-surface">{preview.executive_summary}</p>
      ) : null}

      {preview.message && !hasSteps ? (
        <p className="mt-2 text-[13px] text-on-surface-variant">{preview.message}</p>
      ) : null}

      {hasSteps ? (
        <ol className="mt-2 space-y-1 text-[12px] text-on-surface-variant">
          {preview.steps.map((step, idx) => {
            const tool = String(step.tool ?? "");
            const reason = String(step.expected_outcome ?? "");
            return (
              <li key={`${tool}-${idx}`} className="font-mono">
                {idx + 1}. {tool}
                {reason ? <span className="ml-1 font-sans text-on-surface-variant/90">— {reason}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {preview.error ? (
        <p className="mt-2 text-[13px] text-error">{preview.error}</p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-2">
        {hasSteps ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void onContinue()}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-[13px] font-semibold text-on-primary disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            Continue with follow-up
          </button>
        ) : null}
        <button
          type="button"
          disabled={loading}
          onClick={onDismiss}
          className="rounded-lg px-3 py-1.5 text-[13px] font-semibold text-on-surface-variant hover:bg-surface-container-high"
        >
          Not now
        </button>
      </div>
    </div>
  );
}
