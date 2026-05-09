"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { AgentChatToolExecutionMode } from "@/lib/agentChat";

const OPTIONS: { value: AgentChatToolExecutionMode; label: string; description: string }[] = [
  {
    value: "ask_permission",
    label: "Ask permission",
    description: "Confirm tools before they run",
  },
  {
    value: "auto_accept",
    label: "Auto accept",
    description: "Runs tools immediately (tenant admins only).",
  },
];

export function AgentChatExecModeDropdown({
  value,
  onChange,
  compact,
  menuAlign,
  allowAutoAccept = true,
}: {
  value: AgentChatToolExecutionMode;
  onChange: (v: AgentChatToolExecutionMode) => void;
  /** Smaller trigger for inline footer bars (e.g. Claude-style composer). */
  compact?: boolean;
  /** Popover horizontal alignment relative to the trigger (`end` aligns trailing edges — use in composer footers). */
  menuAlign?: "start" | "end";
  /** When false, “Auto accept” is disabled (tenant admins only on the server). */
  allowAutoAccept?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const indexOfValue = useMemo(() => {
    const idx = OPTIONS.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  }, [value]);

  useEffect(() => {
    if (open) setHighlight(indexOfValue);
  }, [open, indexOfValue]);

  useEffect(() => {
    if (!allowAutoAccept && value === "auto_accept") {
      onChange("ask_permission");
    }
  }, [allowAutoAccept, value, onChange]);

  const isIndexDisabled = useCallback(
    (i: number) => OPTIONS[i]?.value === "auto_accept" && !allowAutoAccept,
    [allowAutoAccept],
  );

  const moveHighlight = useCallback(
    (from: number, delta: 1 | -1) => {
      const n = OPTIONS.length;
      let i = from;
      for (let step = 0; step < n; step++) {
        i = (i + delta + n) % n;
        if (!isIndexDisabled(i)) return i;
      }
      return from;
    },
    [isIndexDisabled],
  );

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => listRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onEsc = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [open]);

  const chosen = OPTIONS[indexOfValue]?.label ?? OPTIONS[0].label;

  const pick = useCallback(
    (v: AgentChatToolExecutionMode) => {
      onChange(v);
      setOpen(false);
      btnRef.current?.focus();
    },
    [onChange],
  );

  const onButtonKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        setOpen(true);
        setHighlight(indexOfValue);
      }
      if (e.key === "Escape") setOpen(false);
    },
    [indexOfValue],
  );

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLUListElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => moveHighlight(i, 1));
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => moveHighlight(i, -1));
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = OPTIONS[highlight];
        if (opt && !isIndexDisabled(highlight)) pick(opt.value);
      }
    },
    [highlight, pick, moveHighlight, isIndexDisabled],
  );

  const selectionId = `${listboxId}-selection`;
  const align = menuAlign ?? (compact ? "end" : "start");
  /** Opens below in compact/footer contexts so the panel does not cover the prompt textarea. */
  const placement = compact ? "below" : "above";

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        ref={btnRef}
        id={`${listboxId}-trigger`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-labelledby={`${listboxId}-tools-prefix ${selectionId}`}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKeyDown}
        className={`inline-flex cursor-pointer items-center justify-between gap-2 rounded-full border border-outline-variant bg-surface-container-high text-left outline-none transition hover:bg-surface-container ${
          compact
            ? "max-w-[200px] px-3 py-2 sm:max-w-[220px]"
            : "w-full max-w-[min(100%,260px)] px-3 py-1.5 sm:max-w-[280px]"
        } ${open ? "border-primary/45 ring-2 ring-primary/25" : ""}`}
      >
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span
            id={`${listboxId}-tools-prefix`}
            className={
              compact
                ? "sr-only"
                : "hidden shrink-0 text-[11px] font-semibold text-on-surface-variant sm:inline"
            }
          >
            Tools
          </span>
          <span
            id={selectionId}
            className={`min-w-0 truncate font-semibold text-on-surface ${compact ? "text-[12px]" : "text-[13px]"}`}
          >
            {chosen}
          </span>
        </span>
        <MaterialSymbol
          name="expand_more"
          className={`shrink-0 text-xl text-on-surface-variant transition-transform ${open ? "rotate-180" : ""}`}
          aria-hidden
        />
      </button>

      {open ? (
        <ul
          ref={listRef}
          id={listboxId}
          role="listbox"
          tabIndex={0}
          aria-labelledby={`${listboxId}-trigger`}
          aria-activedescendant={`${listboxId}-opt-${highlight}`}
          onKeyDown={onListKeyDown}
          className={`absolute z-[60] max-h-[min(280px,40vh)] overflow-auto rounded-xl border border-outline-variant bg-surface-container-lowest py-1.5 shadow-lg outline-none ring-1 ring-black/[0.04] ${
            placement === "below" ? "top-[calc(100%+8px)]" : "bottom-[calc(100%+8px)]"
          } ${
            align === "end"
              ? compact
                ? "right-0 left-auto min-w-full max-w-[min(calc(100vw-2rem),320px)]"
                : "right-0 left-auto w-max min-w-[280px] max-w-[min(calc(100vw-2rem),320px)]"
              : "left-0 w-[min(calc(100vw-2rem),280px)] max-w-[min(calc(100vw-2rem),280px)]"
          }`}
        >
          {OPTIONS.map((opt, i) => {
            const selected = opt.value === value;
            const active = i === highlight;
            const disabled = isIndexDisabled(i);
            return (
              <li key={opt.value} className="list-none" role="presentation">
                <div
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled}
                  title={
                    disabled
                      ? "Tenant administrator role required to use auto accept"
                      : undefined
                  }
                  onMouseEnter={() => {
                    if (!disabled) setHighlight(i);
                  }}
                  onClick={() => {
                    if (disabled) return;
                    pick(opt.value);
                  }}
                  className={`px-3 py-2.5 outline-none transition-colors ${
                    disabled
                      ? "cursor-not-allowed opacity-55"
                      : `cursor-pointer ${active ? "bg-primary-container/50" : "hover:bg-surface-container-high/90"}`
                  }`}
                >
                  <div className="flex items-start gap-2">
                    <span className="mt-0.5 flex w-6 shrink-0 justify-center">
                      {selected ? (
                        <MaterialSymbol name="check" className="text-[20px] text-primary" filled />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1 whitespace-normal">
                      <span className={`block text-[13px] leading-snug ${selected ? "font-bold text-on-surface" : "font-semibold text-on-surface"}`}>
                        {opt.label}
                      </span>
                      <span className="mt-0.5 block text-pretty text-[11px] leading-snug text-on-surface-variant break-words">
                        {opt.description}
                      </span>
                    </span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
