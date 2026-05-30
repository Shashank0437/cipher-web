"use client";

import { type KeyboardEvent as ReactKeyboardEvent, useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceToolCard } from "@/components/tools/types";
import {
  catalogFieldsToFormRows,
  fieldLabel,
  formatDefaultForDisplay,
  formatSourceBadge,
  formatToolCategoryLabel,
  stripEmbeddedAuthoritativeReference,
} from "@/components/tools/toolRunFormUtils";
import { lockModalBodyScroll, unlockModalBodyScroll } from "@/components/tools/modalBodyScrollLock";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

const labelClass = "text-[12px] font-semibold text-on-surface-variant";

function listFocusables(root: HTMLElement): HTMLElement[] {
  const sel =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.closest("[aria-hidden=true]"));
}

export type ToolInfoModalProps = {
  tool: WorkspaceToolCard | null;
  onClose: () => void;
};

export function ToolInfoModal({ tool, onClose }: ToolInfoModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const open = tool !== null;

  useEffect(() => setMounted(true), []);

  const fields = useMemo(() => {
    if (!tool) return [];
    return catalogFieldsToFormRows(
      tool.params ?? {},
      tool.optional ?? {},
      tool.parameter_documentation ?? null,
    );
  }, [tool]);

  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const panel = panelRef.current;
      if (!panel) return;
      const list = listFocusables(panel);
      list[0]?.focus();
    }, 0);
    const onDocKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", onDocKey, true);
    lockModalBodyScroll();
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onDocKey, true);
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

  if (!mounted || !tool) return null;

  const documentationUrl = tool.documentation_url?.trim();
  const aboutRaw = (tool.long_description || tool.description || "").trim();
  const aboutText = stripEmbeddedAuthoritativeReference(aboutRaw, documentationUrl) || "—";

  return createPortal(
    <div className="fixed inset-0 z-[130] flex items-center justify-center p-4 sm:p-6">
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
            <h2 id={titleId} className="mt-2 text-xl font-bold tracking-tight text-on-surface sm:text-2xl">
              {tool.name}
            </h2>
            <p className="mt-2 text-[13px] font-semibold text-on-surface">
              <span className="rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-on-primary-container">
                {formatToolCategoryLabel(tool.category)}
              </span>
            </p>
            <code className="mt-3 block break-all font-mono text-[12px] text-on-surface-variant" title={tool.endpoint}>
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

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 sm:px-6 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-outline-variant [&::-webkit-scrollbar]:w-1.5">
          <section aria-label="About this tool" className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Description</p>
              {documentationUrl ? (
                <a
                  href={documentationUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-xl border border-primary/35 bg-primary-container/40 px-2.5 py-1 text-[12px] font-semibold text-primary transition hover:bg-primary-container focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
                >
                  Official docs
                  <MaterialSymbol name="open_in_new" className="text-[16px]" aria-hidden />
                </a>
              ) : null}
            </div>
            <p className="text-[13px] leading-relaxed text-on-surface whitespace-pre-wrap">{aboutText}</p>
          </section>

          {tool.usage?.trim() ? (
            <section aria-label="Usage guidance" className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">How to use</p>
              <div className="rounded-xl border border-primary/25 bg-primary-container/20 px-3 py-2.5 text-[13px] leading-relaxed text-on-surface whitespace-pre-wrap">
                {tool.usage.trim()}
              </div>
            </section>
          ) : null}

          {tool.safety?.trim() ? (
            <section aria-label="Safety" className="space-y-1.5">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-primary">Safety</p>
              <div className="rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2.5 text-[13px] leading-relaxed text-on-surface whitespace-pre-wrap">
                {tool.safety.trim()}
              </div>
            </section>
          ) : null}

          <section aria-label="Parameters">
            <p className={`${labelClass} mb-3`}>Parameters</p>
            {fields.length === 0 ? (
              <p className="text-[13px] text-on-surface-variant">No parameters listed for this tool.</p>
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
                  const ex = typeof f.docs?.example === "string" && f.docs?.example.trim() ? f.docs.example.trim() : null;
                  const help = typeof f.docs?.help === "string" ? f.docs.help.trim() : "";

                  let defaultRendered: string | null = null;
                  if (hasCatalogDef)
                    defaultRendered = formatDefaultForDisplay(f.kind, vtRaw || undefined, String(catalogDefault));
                  else if (registryFallback !== null)
                    defaultRendered = formatDefaultForDisplay(f.kind, vtRaw || undefined, registryFallback);

                  const sourceBadge = formatSourceBadge(f.docs?.source);

                  return (
                    <div key={f.key} className="rounded-xl border border-outline-variant/80 bg-surface-container-lowest/80 px-3 py-3">
                      <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-on-surface-variant">
                        Field key: <span className="font-mono font-semibold normal-case tracking-normal text-on-surface">{f.key}</span>
                      </p>
                      <div className="mt-2 flex flex-wrap items-baseline gap-1.5">
                        <span className={`${labelClass} normal-case tracking-normal text-on-surface`}>{fieldLabel(f)}</span>
                        {f.required ? <span className="text-error">*</span> : <span className="text-[11px] font-medium text-on-surface-variant">(optional)</span>}
                        {sourceBadge ? (
                          <span className="rounded-md bg-primary/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
                            {sourceBadge}
                          </span>
                        ) : null}
                      </div>
                      {help ? <p className="mt-1.5 text-[12px] leading-relaxed text-on-surface-variant">{help}</p> : null}
                      {defaultRendered !== null ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-on-surface-variant">
                          <span className="font-semibold text-on-surface">Default: </span>
                          <span className="font-mono">{defaultRendered}</span>
                        </p>
                      ) : !f.required ? (
                        <p className="mt-1 text-[11px] leading-relaxed text-on-surface-variant">
                          Omit from the proxied payload when left blank in the run form.
                        </p>
                      ) : null}
                      {ex ? (
                        <p className="mt-1.5 font-mono text-[11px] leading-relaxed text-on-surface-variant">
                          <span className="font-sans font-semibold text-on-surface">Example: </span>
                          {ex}
                        </p>
                      ) : null}
                      {vtRaw ? (
                        <p className="mt-1 text-[11px] text-on-surface-variant">
                          <span className="font-semibold text-on-surface">Type: </span>
                          {vtRaw}
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <div className="flex shrink-0 border-t border-outline-variant bg-surface-container-lowest px-5 py-4 sm:px-6">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex w-full items-center justify-center rounded-xl bg-primary px-5 py-3 text-[15px] font-semibold text-on-primary transition hover:bg-primary-dim focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-lowest"
          >
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
