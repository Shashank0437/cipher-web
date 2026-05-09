"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { getApiPendingSnapshot, subscribeApiPending } from "@/lib/api-pending";
import { LoaderSvg } from "@/components/ui/LoaderSvg";

/** Delay before showing the overlay so fast requests never flash the UI (see `api` / `apiPublic`). */
const SHOW_AFTER_MS = 320;

/** Full-screen translucent overlay shown while authenticated API calls (`api`/`apiPublic`) are in flight on the client. */
export function GlobalPendingApiOverlay() {
  const count = useSyncExternalStore(subscribeApiPending, getApiPendingSnapshot, () => 0);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (count <= 0) {
      setVisible(false);
      return;
    }

    let cancelled = false;
    const t = window.setTimeout(() => {
      if (!cancelled && getApiPendingSnapshot() > 0) setVisible(true);
    }, SHOW_AFTER_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [count]);

  if (!visible || count <= 0) return null;

  return (
    <div
      className="fixed inset-0 z-[9998] flex items-center justify-center bg-[#0f0a1a]/42 backdrop-blur-[2px]"
      aria-busy="true"
      aria-live="polite"
    >
      <div className="flex flex-col items-center gap-4 rounded-3xl bg-surface px-14 py-10 shadow-[0_24px_64px_-12px_rgba(124,58,237,0.35)] ring-1 ring-primary/25">
        <LoaderSvg className="size-14 shrink-0" label="Loading data from server" />
        <p className="text-[13px] font-semibold tracking-wide text-on-surface-variant">Loading workspace…</p>
      </div>
    </div>
  );
}
