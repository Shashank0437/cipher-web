"use client";

import { type FormEvent, type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceToolCard } from "@/components/tools/types";
import { getToolCardTeaser } from "@/components/tools/toolCardTeaser";
import {
  buildInitialStringValues,
  catalogFieldsToFormRows,
  coerceRunPayload,
  fieldLabel,
  formatDefaultForDisplay,
  formatSourceBadge,
  validateRequired,
  type ToolFormField,
} from "@/components/tools/toolRunFormUtils";
import { ApiError, api } from "@/lib/api";
import { lockModalBodyScroll, unlockModalBodyScroll } from "@/components/tools/modalBodyScrollLock";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

type ToolRunModalProps = {
  tool: WorkspaceToolCard | null;
  onClose: () => void;
  onOpenToolInfo?: () => void;
};

const inputClass =
  "mt-1.5 h-10 w-full rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-2 text-[14px] text-on-surface outline-none transition-[border-color,box-shadow] placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary";
const labelClass = "text-[12px] font-semibold text-on-surface-variant";

function listFocusables(root: HTMLElement): HTMLElement[] {
  const sel =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.closest("[aria-hidden=true]"));
}

export function ToolRunModal({ tool, onClose, onOpenToolInfo }: ToolRunModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);

  const [mounted, setMounted] = useState(false);
  const [fields, setFields] = useState<ToolFormField[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [rawResult, setRawResult] = useState<string | null>(null);
  const [errorDetailBody, setErrorDetailBody] = useState<string | null>(null);

  const open = tool !== null;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!tool) return;
    const rows = catalogFieldsToFormRows(
      tool.params ?? {},
      tool.optional ?? {},
      tool.parameter_documentation ?? null,
    );
    setFields(rows);
    setValues(buildInitialStringValues(rows));
    setFormError(null);
    setRawResult(null);
    setErrorDetailBody(null);
    setSubmitting(false);
  }, [tool]);

  /** Escape + overflow; initial focus inside dialog. */
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const list = listFocusables(panel);
      list[0]?.focus();
    }, 0);
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onDocKey);
    lockModalBodyScroll();
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onDocKey);
      unlockModalBodyScroll();
    };
  }, [open, onClose, tool]);

  const onPanelKeyDown = useCallback((e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const list = listFocusables(panel);
    if (!list.length) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    if (e.shiftKey) {
      if (active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (active === last) {
      e.preventDefault();
      first.focus();
    }
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!tool || (tool.method || "POST").toUpperCase() !== "POST") {
      setRawResult(null);
      setErrorDetailBody(null);
      setFormError("Only POST tools can run from this workspace.");
      return;
    }

    const vmsg = validateRequired(fields, values);
    if (vmsg) {
      setRawResult(null);
      setErrorDetailBody(null);
      setFormError(vmsg);
      return;
    }
    const payload = coerceRunPayload(fields, values);

    setFormError(null);
    setRawResult(null);
    setErrorDetailBody(null);
    setSubmitting(true);
    try {
      const res = await api<Record<string, unknown>>("/workspace/tools/run", {
        method: "POST",
        json: { tool_name: tool.name, endpoint: tool.endpoint, payload },
      });
      setRawResult(JSON.stringify(res, null, 2));
    } catch (err) {
      if (err instanceof ApiError) {
        let msg = err.message;
        if (err.body) {
          try {
            const j = JSON.parse(err.body) as { detail?: unknown; error?: unknown };
            if (typeof j.detail === "string") msg = j.detail;
            else if (Array.isArray(j.detail)) msg = JSON.stringify(j.detail);
            else if (typeof j.error === "string") msg = j.error;
          } catch {
            /* keep msg */
          }
          try {
            setErrorDetailBody(JSON.stringify(JSON.parse(err.body), null, 2));
          } catch {
            setErrorDetailBody(err.body);
          }
        }
        setFormError(msg);
      } else {
        setFormError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (!mounted || !tool) return null;

  const teaser = getToolCardTeaser(tool);

  return createPortal(
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/45 backdrop-blur-[2px]"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onPanelKeyDown}
        className="relative z-10 flex max-h-[min(92dvh,880px)] w-full max-w-[640px] flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface shadow-lg ring-1 ring-primary/15"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-outline-variant px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1 pr-2">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Vrika arsenal</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-xl font-bold tracking-tight text-on-surface sm:text-2xl">
                Run {tool.name}
              </h2>
              {onOpenToolInfo ? (
                <button
                  type="button"
                  onClick={onOpenToolInfo}
                  className="inline-flex size-10 shrink-0 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                  aria-label={`Full details for ${tool.name}`}
                  title="Tool details and parameters"
                >
                  <MaterialSymbol name="info" className="text-[22px]" />
                </button>
              ) : null}
            </div>
            <code className="mt-2 block truncate font-mono text-[12px] text-on-surface-variant" title={tool.endpoint}>
              {tool.method?.toUpperCase() ?? "POST"} {tool.endpoint}
            </code>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            aria-label="Close"
          >
            <MaterialSymbol name="close" className="text-[22px]" />
          </button>
        </div>

        <form onSubmit={(e) => void onSubmit(e)} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 sm:px-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-outline-variant [&::-webkit-scrollbar]:w-1.5">
            {formError ? (
              <div className="space-y-2">
                <div
                  role="alert"
                  className="rounded-xl border border-error bg-error-container/30 px-3 py-2 text-[13px] text-error"
                >
                  {formError}
                </div>
                {errorDetailBody ? (
                  <details className="rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2">
                    <summary className="cursor-pointer text-[12px] font-semibold text-on-surface-variant outline-none [&::-webkit-details-marker]:hidden">
                      Details
                    </summary>
                    <pre className="mt-2 max-h-44 overflow-auto border-t border-outline-variant/60 pt-2 font-mono text-[11px] text-on-surface">
                      {errorDetailBody}
                    </pre>
                  </details>
                ) : null}
              </div>
            ) : null}

            <section aria-label="Tool summary" className="space-y-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Summary</p>
              <p className="text-[13px] leading-snug text-on-surface-variant">{teaser || "—"}</p>
              {onOpenToolInfo ? (
                <p className="text-[12px] leading-relaxed text-on-surface-variant">
                  Full description, usage guidance, and safety notes are in{" "}
                  <button
                    type="button"
                    onClick={onOpenToolInfo}
                    className="font-semibold text-primary underline-offset-2 hover:underline"
                  >
                    tool details
                  </button>
                  .
                </p>
              ) : null}
            </section>

            {!tool.active ? (
              <p className="rounded-xl border border-outline-variant bg-surface-container px-3 py-2 text-[12px] leading-relaxed text-on-surface-variant">
                Probe reported not installed — the agent host may reject this command.
              </p>
            ) : null}

            <section aria-label="Parameters">
              <p className={`${labelClass} mb-2`}>Parameters</p>
              {fields.length === 0 ? (
                <p className="text-[13px] text-on-surface-variant">No parameters listed for this tool—you can run it as-is.</p>
              ) : (
                <div className="space-y-5">
                  {fields.map((f) => {
                    const vtRaw = typeof f.docs?.value_type === "string" ? f.docs.value_type.trim() : "";
                    const catalogDefault = (f.docs as { catalog_default?: unknown } | null | undefined)?.catalog_default;
                    const hasCatalogDef =
                      !f.required &&
                      catalogDefault !== undefined &&
                      catalogDefault !== null &&
                      String(catalogDefault) !== "";
                    const registryFallback =
                      !f.required && !hasCatalogDef && f.defaultValue !== undefined && f.defaultValue !== null && `${f.defaultValue}` !== ""
                        ? String(f.defaultValue)
                        : null;
                    const ex =
                      typeof f.docs?.example === "string" && f.docs?.example.trim() ? f.docs.example.trim() : null;
                    const help = typeof f.docs?.help === "string" ? f.docs.help.trim() : "";

                    let defaultRendered: string | null = null;
                    if (hasCatalogDef)
                      defaultRendered = formatDefaultForDisplay(f.kind, vtRaw || undefined, String(catalogDefault));
                    else if (registryFallback !== null)
                      defaultRendered = formatDefaultForDisplay(f.kind, vtRaw || undefined, registryFallback);

                    return (
                      <div key={f.key}>
                      <label className={`${labelClass} flex flex-wrap items-baseline gap-1.5 normal-case tracking-normal text-on-surface`}>
                        <span>{fieldLabel(f)}</span>
                        {f.required ? <span className="text-error">*</span> : null}
                        {(() => {
                          const b = formatSourceBadge(f.docs?.source);
                          return b ? (
                            <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                              {b}
                            </span>
                          ) : null;
                        })()}
                      </label>
                      {help ? (
                        <p className="mt-1.5 text-[12px] leading-relaxed text-on-surface-variant">{help}</p>
                      ) : null}
                      {defaultRendered !== null ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-on-surface-variant">
                          <span className="font-semibold text-on-surface">Default: </span>
                          {defaultRendered}
                        </p>
                      ) : !f.required ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-on-surface-variant">
                          Leave blank to omit this optional field from the proxied payload.
                        </p>
                      ) : null}
                      {ex ? (
                        <p className="mt-1 font-mono text-[11px] leading-relaxed text-on-surface-variant">
                          <span className="font-sans font-semibold text-on-surface">Example: </span>
                          {ex}
                        </p>
                      ) : null}
                      {f.kind === "boolean" ? (
                        <label className="mt-2 flex cursor-pointer items-center gap-3 text-[14px] text-on-surface">
                          <input
                            type="checkbox"
                            className="size-5 rounded-md border-outline-variant accent-primary"
                            checked={values[f.key] === "true"}
                            onChange={(ev) =>
                              setValues((prev) => ({ ...prev, [f.key]: ev.target.checked ? "true" : "false" }))
                            }
                          />
                          <span>Yes</span>
                        </label>
                      ) : f.kind === "number" ? (
                        <input
                          type="text"
                          inputMode="decimal"
                          className={`${inputClass} font-mono`}
                          value={values[f.key] ?? ""}
                          placeholder={String(f.defaultValue ?? "")}
                          autoComplete="off"
                          spellCheck={false}
                          onChange={(ev) => setValues((prev) => ({ ...prev, [f.key]: ev.target.value }))}
                        />
                      ) : (
                        <input
                          type="text"
                          className={inputClass}
                          value={values[f.key] ?? ""}
                          placeholder={String(f.defaultValue ?? "")}
                          autoComplete="off"
                          spellCheck={false}
                          required={false}
                          onChange={(ev) => setValues((prev) => ({ ...prev, [f.key]: ev.target.value }))}
                        />
                      )}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>

            {rawResult ? (
              <section aria-label="Result" className="rounded-xl border border-outline-variant bg-surface-container-low px-3 py-3">
                <p className="text-[13px] font-medium text-on-surface">The tool finished successfully.</p>
                <details className="mt-2">
                  <summary className="cursor-pointer text-[12px] font-semibold text-on-surface-variant outline-none [&::-webkit-details-marker]:hidden">
                    Technical details
                  </summary>
                  <pre className="mt-2 max-h-56 overflow-auto border-t border-outline-variant/60 pt-2 font-mono text-[11px] text-on-surface">
                    {rawResult}
                  </pre>
                </details>
              </section>
            ) : null}
          </div>

          <div className="flex shrink-0 gap-2 border-t border-outline-variant bg-surface-container-lowest px-5 py-4 sm:px-6">
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex flex-1 min-w-[7rem] items-center justify-center gap-2 rounded-xl bg-primary px-4 py-3 text-[15px] font-semibold text-on-primary transition hover:bg-primary-dim disabled:opacity-50"
            >
              {submitting ? (
                <>
                  <MaterialSymbol name="progress_activity" className="animate-spin text-[22px]" />
                  Executing…
                </>
              ) : (
                <>
                  <MaterialSymbol name="play_arrow" className="text-[22px]" filled />
                  Execute
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center rounded-xl border border-outline-variant px-5 py-3 text-[15px] font-semibold text-on-surface transition hover:border-primary hover:text-primary"
            >
              Close
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}
