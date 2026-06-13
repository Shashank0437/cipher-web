"use client";

import type { AttackChainPhase } from "@/lib/agentAttackChains";
import type { AgentChatMessage } from "@/lib/agentChat";

type AttackChainPhaseStripProps = {
  phases: AttackChainPhase[];
  steps: Array<Record<string, unknown>>;
  messages: AgentChatMessage[];
  /** Server-driven step index (0 = first tool pending). Preferred over tool-name inference. */
  currentStep?: number | null;
};

function completedToolsFromMessages(messages: AgentChatMessage[]): Set<string> {
  const completed = new Set<string>();
  for (const m of messages) {
    const slots = m.tool_calls;
    if (Array.isArray(slots)) {
      for (const slot of slots) {
        const tn = String(slot.tool_name ?? "").trim().toLowerCase();
        if (!tn) continue;
        const eo = String(slot.execution_outcome ?? "").toLowerCase();
        const hd = String(slot.human_decision ?? "").toLowerCase();
        if (eo === "completed" || eo === "done" || eo === "success") {
          if (hd !== "reject") completed.add(tn);
        }
      }
    }
    if (m.role === "tool" && m.tool_name) {
      completed.add(String(m.tool_name).trim().toLowerCase());
    }
  }
  return completed;
}

function activeToolFromStepIndex(
  steps: Array<Record<string, unknown>>,
  currentStep: number | undefined | null,
  completed: Set<string>,
): string | null {
  if (typeof currentStep === "number" && currentStep >= 0 && currentStep < steps.length) {
    const tn = String(steps[currentStep].tool ?? "").trim().toLowerCase();
    if (tn) return tn;
  }
  for (const step of steps) {
    const tn = String(step.tool ?? "").trim().toLowerCase();
    if (tn && !completed.has(tn)) return tn;
  }
  return null;
}

function phaseStatusByIndex(
  phase: AttackChainPhase,
  currentStep: number,
): "done" | "active" | "pending" {
  const indices = phase.step_indices ?? [];
  if (!indices.length) return "pending";
  const maxIdx = Math.max(...indices);
  const minIdx = Math.min(...indices);
  if (maxIdx < currentStep) return "done";
  if (minIdx <= currentStep && currentStep <= maxIdx) return "active";
  return "pending";
}

function phaseStatus(
  phase: AttackChainPhase,
  steps: Array<Record<string, unknown>>,
  completed: Set<string>,
  activeTool: string | null,
): "done" | "active" | "pending" {
  const indices = phase.step_indices ?? [];
  const tools = indices
    .map((idx) => {
      const step = steps[idx];
      if (!step) return "";
      return String(step.tool ?? "").trim().toLowerCase();
    })
    .filter(Boolean);

  if (!tools.length) return "pending";

  const allDone = tools.every((t) => completed.has(t));
  if (allDone) return "done";

  if (activeTool && tools.includes(activeTool)) return "active";

  const anyDone = tools.some((t) => completed.has(t));
  if (anyDone) return "active";

  return "pending";
}

export function isAttackChainComplete(
  steps: Array<Record<string, unknown>>,
  messages: AgentChatMessage[],
  currentStep?: number | null,
): boolean {
  if (!steps.length) return false;
  if (typeof currentStep === "number" && currentStep >= steps.length) return true;
  const completed = completedToolsFromMessages(messages);
  for (const step of steps) {
    const tn = String(step.tool ?? "").trim().toLowerCase();
    if (tn && !completed.has(tn)) return false;
  }
  return true;
}

export function AttackChainPhaseStrip({
  phases,
  steps,
  messages,
  currentStep,
}: AttackChainPhaseStripProps) {
  if (!phases.length) return null;

  const completed = completedToolsFromMessages(messages);
  const stepIndex =
    typeof currentStep === "number" && currentStep >= 0 ? currentStep : completed.size;
  const activeTool = activeToolFromStepIndex(steps, currentStep, completed);
  const useIndexDriver = typeof currentStep === "number";

  return (
    <div
      className="mb-2 rounded-xl border border-primary/20 bg-primary-container/20 px-3 py-2"
      role="status"
      aria-label="Attack chain phase progress"
    >
      <p className="text-[11px] font-bold uppercase tracking-wide text-on-surface-variant/90">
        Attack chain progress
      </p>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12px]">
        {phases.map((phase, idx) => {
          const status = useIndexDriver
            ? phaseStatusByIndex(phase, stepIndex)
            : phaseStatus(phase, steps, completed, activeTool);
          const label = phase.label || phase.phase;
          const symbol = status === "done" ? "✓" : status === "active" ? "●" : "○";
          return (
            <span key={`${phase.phase}-${idx}`} className="inline-flex items-center gap-1">
              {idx > 0 ? (
                <span className="text-on-surface-variant/50" aria-hidden>→</span>
              ) : null}
              <span
                className={
                  status === "done"
                    ? "font-semibold text-primary"
                    : status === "active"
                      ? "font-semibold text-on-surface"
                      : "text-on-surface-variant"
                }
              >
                {label} {symbol}
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
