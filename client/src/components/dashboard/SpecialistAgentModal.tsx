"use client";

import { Loader2, Target } from "lucide-react";
import { useEffect, useState } from "react";
import type { SpecialistAgentParams, SpecialistAgentPlan } from "@/lib/agentSpecialists";

type SpecialistAgentModalProps = {
  agent: SpecialistAgentPlan | null;
  open: boolean;
  onClose: () => void;
  onStart: (params: SpecialistAgentParams) => void | Promise<void>;
  starting?: boolean;
  error?: string | null;
};

function emptyForm(agent: SpecialistAgentPlan | null): SpecialistAgentParams {
  if (!agent) return {};
  const base: SpecialistAgentParams = {};
  if (agent.fields.includes("preset") || agent.fields.includes("type")) {
    const key = agent.id === "recon" ? "type" : "preset";
    base[key] = agent.default_preset;
  }
  return base;
}

export function SpecialistAgentModal({
  agent,
  open,
  onClose,
  onStart,
  starting = false,
  error,
}: SpecialistAgentModalProps) {
  const [form, setForm] = useState<SpecialistAgentParams>({});

  useEffect(() => {
    if (open && agent) {
      setForm(emptyForm(agent));
    }
  }, [open, agent?.id]);

  if (!open || !agent) return null;

  const busy = starting;
  const set = (key: string, value: string) => setForm((prev) => ({ ...prev, [key]: value }));

  const canStart = (() => {
    if (busy) return false;
    if (agent.id === "htb-ctf") {
      return Boolean(form.target?.trim() && form.goal?.trim());
    }
    if (agent.id === "bugbounty") {
      return Boolean(
        form.program?.trim() && form.target?.trim() && form.scope?.trim() && form.goal?.trim(),
      );
    }
    return Boolean(form.target?.trim());
  })();

  const presetKey = agent.id === "recon" ? "type" : "preset";

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-labelledby="specialist-agent-modal-title"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-2xl border border-outline-variant/60 bg-surface-container-lowest shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 border-b border-outline-variant/50 px-5 py-4">
          <h2 id="specialist-agent-modal-title" className="text-lg font-bold text-on-surface">
            Start {agent.title}
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

        <div className="max-h-[min(70vh,640px)] space-y-4 overflow-y-auto px-5 py-4">
          <p className="text-[14px] leading-relaxed text-on-surface-variant">{agent.modal_description}</p>

          {agent.id === "bugbounty" ? (
            <div>
              <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-program">
                Program <span className="text-error">*</span>
              </label>
              <input
                id="sa-program"
                type="text"
                value={form.program ?? ""}
                onChange={(e) => set("program", e.target.value)}
                placeholder="HackerOne - Acme Corp"
                className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                disabled={busy}
              />
            </div>
          ) : null}

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-target">
              Target <span className="text-error">*</span>
            </label>
            <input
              id="sa-target"
              type="text"
              value={form.target ?? ""}
              onChange={(e) => set("target", e.target.value)}
              placeholder={agent.placeholder_target}
              className="mt-1.5 w-full rounded-xl border border-primary/40 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none ring-primary/20 focus:ring-2"
              disabled={busy}
            />
          </div>

          {agent.id === "bugbounty" ? (
            <>
              <div>
                <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-scope">
                  Scope <span className="text-error">*</span>
                </label>
                <input
                  id="sa-scope"
                  type="text"
                  value={form.scope ?? ""}
                  onChange={(e) => set("scope", e.target.value)}
                  placeholder="*.acme.com, api.acme.com"
                  className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                  disabled={busy}
                />
              </div>
              <div>
                <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-oos">
                  Out of scope
                </label>
                <input
                  id="sa-oos"
                  type="text"
                  value={form.out_of_scope ?? ""}
                  onChange={(e) => set("out_of_scope", e.target.value)}
                  placeholder="blog.acme.com, status.acme.com"
                  className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                  disabled={busy}
                />
              </div>
            </>
          ) : null}

          {agent.id !== "recon" ? (
            <div>
              <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-goal">
                Goal <span className="text-error">*</span>
              </label>
              <input
                id="sa-goal"
                type="text"
                value={form.goal ?? ""}
                onChange={(e) => set("goal", e.target.value)}
                placeholder={agent.placeholder_goal ?? "P1/P2 vulnerabilities"}
                className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                disabled={busy}
              />
            </div>
          ) : null}

          {agent.presets.length > 0 ? (
            <div>
              <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-preset">
                {agent.id === "recon" ? "Target type" : "Preset"}
              </label>
              <select
                id="sa-preset"
                value={form[presetKey] ?? agent.default_preset}
                onChange={(e) => set(presetKey, e.target.value)}
                className="mt-1.5 w-full rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
                disabled={busy}
              >
                {agent.presets.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          <div>
            <label className="text-[13px] font-semibold text-on-surface" htmlFor="sa-notes">
              Notes (optional)
            </label>
            <textarea
              id="sa-notes"
              value={form.notes ?? ""}
              onChange={(e) => set("notes", e.target.value)}
              placeholder="Extra context, auth tokens, prior recon…"
              rows={3}
              className="mt-1.5 w-full resize-none rounded-xl border border-outline-variant/60 bg-surface-container-low px-3 py-2.5 text-[14px] text-on-surface outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
              disabled={busy}
            />
          </div>

          {error ? (
            <p className="rounded-lg border border-error/30 bg-error/10 px-3 py-2 text-[13px] text-error">
              {error}
            </p>
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
          <button
            type="button"
            disabled={!canStart}
            onClick={() => void onStart(form)}
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
