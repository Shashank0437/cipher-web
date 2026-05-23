"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import { useAuth } from "@/lib/auth-context";

const ADMIN_ONLY_PATH_PREFIXES = [
  "/dashboard/analytics",
  "/dashboard/tools",
  "/dashboard/usage",
  "/dashboard/users",
] as const;

function pathRequiresTenantAdmin(pathname: string): boolean {
  return ADMIN_ONLY_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

export function DashboardRoleGuard({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const { user } = useAuth();
  const isAdmin = !!user?.roles?.includes("tenant_admin");
  const blocked = !!user && pathRequiresTenantAdmin(pathname) && !isAdmin;

  useEffect(() => {
    if (!user || !blocked) return;
    router.replace("/dashboard");
  }, [user, blocked, router]);

  if (blocked) {
    return null;
  }

  return <>{children}</>;
}
