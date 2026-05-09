"use client";

import { useState } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { FAQ_ITEMS } from "./landing-data";

type Item = (typeof FAQ_ITEMS)[number];

export function LandingFaq({ items }: { items: readonly Item[] }) {
  const [open, setOpen] = useState<number | null>(0);

  return (
    <div className="mx-auto max-w-3xl space-y-3">
      {items.map((item, idx) => {
        const expanded = open === idx;
        return (
          <div key={item.q} className="overflow-hidden rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-sm">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : idx)}
              className="flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors hover:bg-surface-container-high/60"
            >
              <span className="font-semibold text-on-surface">{item.q}</span>
              <MaterialSymbol
                name="expand_more"
                className={`shrink-0 text-2xl text-primary transition-transform ${expanded ? "rotate-180" : ""}`}
              />
            </button>
            <div className={`grid transition-[grid-template-rows] duration-300 ${expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
              <div className="overflow-hidden">
                <p className="border-t border-outline-variant/70 px-5 pb-4 pt-3 text-sm leading-relaxed text-on-surface-variant">
                  {item.a}
                </p>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
