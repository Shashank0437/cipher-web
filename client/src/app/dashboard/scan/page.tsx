"use client";

import { Suspense } from "react";
import { InitializeOffensiveSequencePage } from "@/components/dashboard/InitializeOffensiveSequencePage";
import { LoaderSvg } from "@/components/ui/LoaderSvg";
import { useAuth } from "@/lib/auth-context";

function ScanLoading() {
  return (
    <div className="flex min-h-[50dvh] flex-col items-center justify-center gap-3 bg-background text-on-surface-variant">
      <LoaderSvg className="size-10" label="Loading agent workspace" />
      <p className="text-sm font-medium">Loading workspace…</p>
    </div>
  );
}

export default function DashboardScanPage() {
  const { user } = useAuth();
  if (!user) {
    return null;
  }
  return (
    <Suspense fallback={<ScanLoading />}>
      <InitializeOffensiveSequencePage user={user} />
    </Suspense>
  );
}
