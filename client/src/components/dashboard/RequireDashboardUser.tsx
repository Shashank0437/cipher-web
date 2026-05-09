"use client";

import { useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { LoaderSvg } from "@/components/ui/LoaderSvg";
import { useAuth } from "@/lib/auth-context";

/** Same login gate as `DashboardShell`, for routes that omit the shell chrome (e.g. agentic scan). */
export function RequireDashboardUser({ children }: { children: ReactNode }) {
  const router = useRouter();
  const { user, loading } = useAuth();

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  if (loading || !user) {
    return (
      <div
        className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-background text-on-surface-variant"
        aria-busy="true"
      >
        <LoaderSvg className="size-12" label="Loading workspace session" />
        <p className="text-sm font-medium">Loading…</p>
      </div>
    );
  }

  return <>{children}</>;
}
