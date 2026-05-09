"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { ToolAvailabilityFilter } from "@/components/tools/types";

export type AvailabilityOption = { value: ToolAvailabilityFilter; label: string };

export function ToolAvailabilityDropdown({
  value,
  onChange,
  options,
  labelledBy,
}: {
  value: ToolAvailabilityFilter;
  onChange: (v: ToolAvailabilityFilter) => void;
  options: readonly AvailabilityOption[];
  /** id of an element that labels this control (e.g. sr-only span). */
  labelledBy?: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const listboxId = useId();

  const indexOfValue = useMemo(() => {
    const idx = options.findIndex((o) => o.value === value);
    return idx >= 0 ? idx : 0;
  }, [options, value]);

  useEffect(() => {
    if (open) setHighlight(indexOfValue);
  }, [open, indexOfValue]);

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

  const chosen = options[indexOfValue]?.label ?? options[0]?.label ?? "";
  const selectionId = `${listboxId}-selection`;
  const triggerLabelledBy = [labelledBy, selectionId].filter(Boolean).join(" ") || undefined;

  const pick = useCallback(
    (v: ToolAvailabilityFilter) => {
      onChange(v);
      setOpen(false);
      btnRef.current?.focus();
    },
    [onChange],
  );

  const onButtonKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen(true);
      setHighlight(indexOfValue);
      return;
    }
    if (e.key === "Escape") setOpen(false);
  }, [indexOfValue]);

  const onListKeyDown = useCallback(
    (e: KeyboardEvent<HTMLUListElement>) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((i) => (i + 1) % options.length);
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((i) => (i - 1 + options.length) % options.length);
      }
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) pick(opt.value);
      }
    },
    [highlight, options, pick],
  );

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

  return (
    <div ref={rootRef} className="relative min-w-0 sm:min-w-[16rem]">
      <button
        ref={btnRef}
        id={`${listboxId}-trigger`}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={labelledBy ? undefined : "Tool availability filter"}
        aria-labelledby={triggerLabelledBy}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onButtonKeyDown}
        className={`flex h-10 w-full cursor-pointer items-center justify-between gap-3 rounded-xl border-2 bg-surface-container-lowest py-2 pl-3 pr-2 text-left text-[13px] font-semibold text-on-surface outline-none transition-[border-color,box-shadow] ${
          open
            ? "border-primary shadow-sm ring-2 ring-primary/20"
            : "border-outline-variant hover:border-primary/50"
        }`}
      >
        <span id={selectionId} className="min-w-0 truncate">
          {chosen}
        </span>
        <MaterialSymbol
          name="expand_more"
          className={`shrink-0 text-on-surface-variant transition-transform ${open ? "rotate-180" : ""}`}
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
          className="absolute left-0 right-0 top-[calc(100%+6px)] z-50 overflow-hidden rounded-xl border border-neutral-600/90 bg-neutral-800 py-1.5 text-[13px] text-white shadow-[0_12px_40px_rgba(0,0,0,0.38)] outline-none ring-1 ring-black/40"
        >
          {options.map((opt, i) => {
            const selected = opt.value === value;
            const active = i === highlight;
            return (
              <li key={opt.value} className="list-none" role="presentation">
                <div
                  id={`${listboxId}-opt-${i}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setHighlight(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(opt.value)}
                  className={`flex cursor-pointer items-center gap-2 px-3 py-2.5 outline-none transition-colors ${active ? "bg-white/[0.09]" : "hover:bg-white/[0.06]"}`}
                >
                  <span className="flex w-6 shrink-0 justify-center">
                    {selected ? <MaterialSymbol name="check" className="text-[20px]" filled /> : null}
                  </span>
                  <span className={selected ? "font-semibold text-white" : "text-neutral-100"}>{opt.label}</span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
