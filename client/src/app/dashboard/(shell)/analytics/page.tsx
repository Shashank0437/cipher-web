import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

export default function DashboardAnalyticsPage() {
  return (
    <div className="mx-auto max-w-[900px] px-6 py-12">
      <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Analytics</p>
      <h1 className="mt-2 text-[1.75rem] font-bold tracking-tight text-on-surface">Operational analytics</h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-on-surface-variant">
        Breach-time trends, SLA posture, and executive rollups plug in here as the CipherStrike backend lands.
      </p>
      <div className="mt-12 flex aspect-video max-w-xl items-center justify-center rounded-2xl border border-dashed border-outline-variant bg-surface-container-low text-on-surface-variant">
        <div className="flex flex-col items-center gap-2 text-center px-8">
          <MaterialSymbol name="query_stats" className="text-5xl text-primary/60" filled />
          <p className="text-sm font-medium">Charts sync with Sessions &mdash; scaffolding only for now.</p>
        </div>
      </div>
    </div>
  );
}
