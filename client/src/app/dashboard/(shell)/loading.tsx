import { LoaderSvg } from "@/components/ui/LoaderSvg";

/** Shown during Next.js client navigations inside `/dashboard/*` while the segment loads. */
export default function DashboardSegmentLoading() {
  return (
    <div
      className="flex min-h-[calc(100dvh-4.5rem)] w-full items-center justify-center bg-[#f4f0fc]/30"
      aria-busy="true"
    >
      <div className="flex min-h-[12.5rem] w-full max-w-sm flex-col items-center justify-center gap-4 rounded-3xl bg-surface px-10 py-8 shadow-lg ring-1 ring-outline-variant/80">
        <LoaderSvg className="size-[3.25rem] shrink-0" label="Loading dashboard" />
        <p className="text-[13px] font-semibold text-on-surface-variant">Loading…</p>
      </div>
    </div>
  );
}
