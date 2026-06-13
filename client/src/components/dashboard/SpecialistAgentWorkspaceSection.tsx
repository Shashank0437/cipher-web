"use client";

import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { SpecialistAgentPlan } from "@/lib/agentSpecialists";

const AGENT_ICONS: Record<string, string> = {
  "htb-ctf": "flag",
  bugbounty: "bug_report",
  recon: "travel_explore",
};

type SpecialistAgentWorkspaceSectionProps = {
  agents: SpecialistAgentPlan[];
  onSelectAgent: (agent: SpecialistAgentPlan) => void;
};

export function SpecialistAgentWorkspaceSection({
  agents,
  onSelectAgent,
}: SpecialistAgentWorkspaceSectionProps) {
  const featured = agents.find((a) => a.featured);
  const rest = agents.filter((a) => !a.featured);

  return (
    <div id="specialist-agent-workspace" className="w-full scroll-mt-6">
      {featured ? (
        <div className="relative overflow-hidden rounded-2xl border-2 border-primary/45 bg-gradient-to-br from-primary-container/55 via-surface-container-lowest to-primary/10 p-5 ring-1 ring-primary/25 sm:p-6">
          <div className="relative flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/15 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-primary">
                  <MaterialSymbol name="smart_toy" className="text-[14px]" filled />
                  Specialist agent
                </span>
                <span className="rounded-full bg-surface-container-high/90 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                  {featured.specialist_count} specialists
                </span>
              </div>
              <h3 className="mt-3 text-xl font-bold tracking-tight text-on-surface sm:text-2xl">
                {featured.title}
              </h3>
              <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-on-surface-variant sm:text-[15px]">
                {featured.modal_description}
              </p>
              <ol className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[12px] font-medium text-on-surface-variant/90 sm:text-[13px]">
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    1
                  </span>
                  Configure target & goal
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    2
                  </span>
                  Review attack plan
                </li>
                <li className="inline-flex items-center gap-1.5">
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/20 text-[10px] font-bold text-primary">
                    3
                  </span>
                  Confirm, then run kill chain
                </li>
              </ol>
            </div>
            <button
              type="button"
              onClick={() => onSelectAgent(featured)}
              className="group inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-[14px] font-bold text-on-primary transition hover:brightness-[1.03] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
            >
              Configure & start
              <MaterialSymbol
                name="arrow_forward"
                className="text-[18px] transition group-hover:translate-x-0.5"
                filled
              />
            </button>
          </div>
        </div>
      ) : null}

      {rest.length > 0 ? (
        <div className={featured ? "mt-8" : ""}>
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary/90">
                More specialist agents
              </p>
              <h3 className="mt-1 text-lg font-bold text-on-surface">Autonomous engagement runners</h3>
              <p className="mt-1 max-w-xl text-[13px] leading-relaxed text-on-surface-variant">
                Click a card to configure scope and goals. The leader waits for your confirmation before tools run.
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            {rest.map((agent) => (
              <button
                key={agent.id}
                type="button"
                onClick={() => onSelectAgent(agent)}
                className="group relative flex gap-4 rounded-2xl border border-outline-variant/80 bg-surface-container-lowest p-4 text-left transition hover:-translate-y-0.5 hover:border-primary/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/40"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-surface-container-high text-primary ring-1 ring-outline-variant/60 transition group-hover:bg-primary-container/80 group-hover:ring-primary/25">
                  <MaterialSymbol
                    name={AGENT_ICONS[agent.id] ?? "smart_toy"}
                    className="text-2xl"
                    filled
                  />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="font-bold text-on-surface">{agent.title}</p>
                    <span className="shrink-0 rounded-md border border-outline-variant/70 bg-surface-container-high/80 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                      {agent.badge}
                    </span>
                  </div>
                  <p className="mt-1 text-[13px] leading-snug text-on-surface-variant">{agent.description}</p>
                  <p className="mt-2 text-[11px] text-on-surface-variant/75">
                    {agent.specialist_count} specialist subagents
                  </p>
                  <span className="mt-3 inline-flex items-center gap-1 text-[12px] font-bold text-primary opacity-90 transition group-hover:opacity-100">
                    Configure & start
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
