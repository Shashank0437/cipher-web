"use client";

import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { AttackChainPlan } from "@/lib/agentAttackChains";

const ATTACK_CHAIN_ICONS: Record<string, string> = {
  intelligent_attack_chain: "auto_awesome",
  ai_recon: "radar",
  ai_profiling: "person_search",
  ai_vuln: "bug_report",
  ai_osint: "public",
};

type AttackChainWorkspaceSectionProps = {
  plans: AttackChainPlan[];
  onSelectPlan: (plan: AttackChainPlan) => void;
};

export function AttackChainWorkspaceSection({ plans, onSelectPlan }: AttackChainWorkspaceSectionProps) {
  const intelligent = plans.find((p) => p.id === "intelligent_attack_chain");
  const fixed = plans.filter((p) => p.id !== "intelligent_attack_chain");

  return (
    <div id="attack-chain-workspace" className="w-full scroll-mt-6">
      {intelligent ? (
        <div className="relative overflow-hidden rounded-2xl border-2 border-primary/45 bg-gradient-to-br from-primary-container/55 via-surface-container-lowest to-primary/10 p-5 shadow-[0_20px_50px_-28px_rgba(104,76,182,0.55)] ring-1 ring-primary/25 sm:p-6">
          <div
            className="pointer-events-none absolute -right-8 -top-8 h-32 w-32 rounded-full bg-primary/15 blur-2xl"
            aria-hidden
          />
          <div
            className="pointer-events-none absolute -bottom-10 -left-6 h-28 w-28 rounded-full bg-primary/10 blur-2xl"
            aria-hidden
          />

          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
                  <MaterialSymbol name="stars" className="text-[14px]" filled />
                  Master workflow
                </span>
                <span className="rounded-full bg-surface-container-high/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  Recommended
                </span>
              </div>
              <h3 className="mt-3 text-xl font-bold tracking-tight text-on-surface sm:text-2xl">
                {intelligent.title}
              </h3>
              <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-on-surface-variant sm:text-[15px]">
                {intelligent.modal_description}
              </p>
              <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium text-on-surface-variant/90 sm:text-[13px]">
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    1
                  </span>
                  Set target & precision
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    2
                  </span>
                  Preview AI plan
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    3
                  </span>
                  Run tools one-by-one
                </li>
              </ol>
            </div>
            <button
              type="button"
              onClick={() => onSelectPlan(intelligent)}
              className="group inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-[14px] font-bold text-on-primary shadow-[0_8px_24px_-8px_rgba(104,76,182,0.65)] transition hover:brightness-[1.03] hover:shadow-[0_12px_28px_-10px_rgba(104,76,182,0.7)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Configure & preview
              <MaterialSymbol
                name="arrow_forward"
                className="text-[18px] transition group-hover:translate-x-0.5"
                filled
              />
            </button>
          </div>
        </div>
      ) : null}

      {fixed.length > 0 ? (
        <div className="mt-8">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary/90">
                Predefined pipelines
              </p>
              <h3 className="mt-1 text-lg font-bold text-on-surface">Fixed attack chains</h3>
              <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-on-surface-variant">
                Click a pipeline card to enter your target, review the tool order, and start the session.
              </p>
            </div>
            <p className="mt-2 text-[12px] font-medium text-on-surface-variant/80 sm:mt-0">
              <MaterialSymbol name="touch_app" className="mr-1 inline text-[16px] align-[-2px]" />
              Click any card to launch
            </p>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {fixed.map((plan) => (
              <button
                key={plan.id}
                type="button"
                onClick={() => onSelectPlan(plan)}
                className="group relative flex gap-4 rounded-2xl border border-outline-variant/80 bg-surface-container-lowest p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-container-high text-primary ring-1 ring-outline-variant/60 transition group-hover:bg-primary-container/80 group-hover:ring-primary/25">
                  <MaterialSymbol
                    name={ATTACK_CHAIN_ICONS[plan.id] ?? "route"}
                    className="text-2xl"
                    filled
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-bold text-on-surface">{plan.title}</p>
                    <span className="shrink-0 rounded-md border border-outline-variant/70 bg-surface-container-high/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      {plan.badge}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] leading-snug text-on-surface-variant">{plan.description}</p>
                  {plan.tools.length > 0 ? (
                    <p className="mt-2 truncate text-[11px] font-mono text-on-surface-variant/75">
                      {plan.tools.slice(0, 5).join(" · ")}
                      {plan.tools.length > 5 ? " …" : ""}
                    </p>
                  ) : null}
                  <span
                    className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-primary opacity-90 transition group-hover:opacity-100"
                  >
                    Start pipeline
                    <MaterialSymbol
                      name="chevron_right"
                      className="text-[16px] transition group-hover:translate-x-0.5"
                    />
                  </span>
                </div>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
