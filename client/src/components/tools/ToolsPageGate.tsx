"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { ToolsWorkspace } from "@/components/tools/ToolsWorkspace";

export function ToolsPageGate() {
  const { user, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) {
      router.replace("/login?next=/tools");
      return;
    }
    if (!user.roles?.includes("tenant_admin")) {
      router.replace("/dashboard");
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-on-surface-variant">
        Checking access…
      </div>
    );
  }

  if (!user?.roles?.includes("tenant_admin")) {
    return null;
  }

  return <ToolsWorkspace intro="full" />;
}
