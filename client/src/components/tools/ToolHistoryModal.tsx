"use client";

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError, api } from "@/lib/api";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

const HISTORY_PAGE_SIZE = 20;

export type ToolHistoryEntry = {
  id: string;
  tool_name: string;
  created_at: string;
  agent_status_code: number;
  success: boolean | null;
  execution_time: number | null;
  return_code: number | null;
  stdout: string;
  stderr: string;
  endpoint?: string;
  request_payload?: Record<string, unknown>;
  response_snippet?: string;
};

export type ToolHistoryPageResponse = {
  items: ToolHistoryEntry[];
  total: number;
  limit: number;
  offset: number;
};

function formatRequestSnapshot(payload: Record<string, unknown>): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

type ToolHistoryModalProps = {
  toolName: string | null;
  onClose: () => void;
};

function listFocusables(root: HTMLElement): HTMLElement[] {
  const sel =
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...root.querySelectorAll<HTMLElement>(sel)].filter((el) => !el.closest("[aria-hidden=true]"));
}

export function ToolHistoryModal({ toolName, onClose }: ToolHistoryModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<ToolHistoryEntry[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);

  const open = toolName !== null;

  useEffect(() => setMounted(true), []);

  const loadPage = useCallback(
    async (pageNum: number) => {
      if (!toolName) return;
      setLoading(true);
      setError(null);
      try {
        const offset = (pageNum - 1) * HISTORY_PAGE_SIZE;
        const q = new URLSearchParams({
          tool: toolName,
          limit: String(HISTORY_PAGE_SIZE),
          offset: String(offset),
        });
        const res = await api<ToolHistoryPageResponse>(`/workspace/tools/history?${q.toString()}`);
        setEntries(res.items);
        setTotal(res.total);
        setPage(pageNum);
      } catch (e) {
        if (e instanceof ApiError) setError(e.message);
        else setError(e instanceof Error ? e.message : "Failed to load history");
        setEntries([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    },
    [toolName],
  );

  useEffect(() => {
    if (toolName) void loadPage(1);
  }, [toolName, loadPage]);

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
    document.body.style.overflow = "hidden";
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("keydown", onDocKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

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

  if (!mounted || !toolName) return null;

  const totalPages = Math.max(1, Math.ceil(total / HISTORY_PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : (page - 1) * HISTORY_PAGE_SIZE + 1;
  const rangeEnd = total === 0 ? 0 : (page - 1) * HISTORY_PAGE_SIZE + entries.length;
  const canPrev = page > 1 && !loading;
  const canNext = rangeEnd < total && !loading;

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
        className="relative z-10 flex max-h-[min(92dvh,880px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-outline-variant bg-surface shadow-lg ring-1 ring-primary/15"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-outline-variant px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Run history</p>
            <h2 id={titleId} className="mt-2 text-xl font-bold tracking-tight text-on-surface">
              {toolName}
            </h2>
            <p className="mt-1 text-[13px] text-on-surface-variant">Recent executions for your organization.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary"
            aria-label="Close"
          >
            <MaterialSymbol name="close" className="text-[22px]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
          {error ? (
            <div className="rounded-xl border border-error bg-error-container/30 px-3 py-2 text-[13px] text-error">
              {error}
            </div>
          ) : null}
          {loading ? (
            <p className="text-[13px] text-on-surface-variant">Loading…</p>
          ) : !error && entries.length === 0 ? (
            <p className="text-[13px] text-on-surface-variant">No recorded runs yet.</p>
          ) : (
            <ul className="space-y-3">
              {entries.map((en) => (
                <li key={en.id} className="rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <time className="font-mono text-[12px] text-on-surface-variant">
                      {new Date(en.created_at).toLocaleString()}
                    </time>
                    <span className="text-[12px] font-semibold text-on-surface">
                      {en.success === true ? "Success" : en.success === false ? "Reported failure" : "Completed"}{" "}
                      <span className="font-normal text-on-surface-variant">
                        · HTTP {en.agent_status_code}
                        {en.execution_time != null ? ` · ${en.execution_time}s` : ""}
                        {en.return_code != null ? ` · exit ${en.return_code}` : ""}
                      </span>
                    </span>
                  </div>
                  {en.endpoint ? (
                    <p className="mt-2 break-all font-mono text-[11px] text-on-surface-variant">
                      <span className="font-semibold text-on-surface">Agent route:</span> {en.endpoint}
                    </p>
                  ) : null}
                  {Object.keys(en.request_payload ?? {}).length > 0 ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-semibold text-on-surface-variant">
                        Request
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-on-surface">
                        {formatRequestSnapshot(en.request_payload ?? {})}
                      </pre>
                    </details>
                  ) : null}
                  {en.stdout.trim() ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-semibold text-on-surface-variant">
                        Output (stdout)
                      </summary>
                      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-on-surface">
                        {en.stdout}
                      </pre>
                    </details>
                  ) : null}
                  {en.stderr.trim() ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-semibold text-error">Errors (stderr)</summary>
                      <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-error">
                        {en.stderr}
                      </pre>
                    </details>
                  ) : null}
                  {(en.response_snippet ?? "").trim() ? (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-[12px] font-semibold text-on-surface-variant">
                        Response body
                      </summary>
                      <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[11px] text-on-surface">
                        {en.response_snippet}
                      </pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="shrink-0 border-t border-outline-variant px-5 py-3 sm:px-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="button"
              onClick={() => void loadPage(page)}
              className="text-[13px] font-semibold text-primary hover:underline disabled:opacity-50"
              disabled={loading}
            >
              Refresh
            </button>
            {total > 0 ? (
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <p className="text-[12px] text-on-surface-variant" aria-live="polite">
                  {rangeStart}–{rangeEnd} of {total}
                </p>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void loadPage(page - 1)}
                    disabled={!canPrev}
                    className="flex size-9 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Previous page"
                  >
                    <MaterialSymbol name="chevron_left" className="text-[22px]" />
                  </button>
                  <span className="min-w-[5.5rem] text-center font-mono text-[12px] text-on-surface">
                    {page} / {totalPages}
                  </span>
                  <button
                    type="button"
                    onClick={() => void loadPage(page + 1)}
                    disabled={!canNext}
                    className="flex size-9 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary disabled:pointer-events-none disabled:opacity-40"
                    aria-label="Next page"
                  >
                    <MaterialSymbol name="chevron_right" className="text-[22px]" />
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
