"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { ReactNode } from "react";
import { useEffect, useMemo } from "react";
import { DashboardHeaderProfile } from "@/components/dashboard/DashboardHeaderProfile";
import { LoaderSvg } from "@/components/ui/LoaderSvg";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { useAuth } from "@/lib/auth-context";
import { COMING_SOON_FROM_DASHBOARD_QUERY } from "@/lib/coming-soon-routes";

type NavMain = {
  href: string;
  label: string;
  icon: string;
  match: "exact" | "prefix";
  adminOnly?: boolean;
};

const MAIN_NAV: NavMain[] = [
  { href: "/dashboard", label: "Sessions", icon: "history", match: "exact" },
  { href: "/dashboard/usage", label: "Usage", icon: "analytics", match: "prefix" },
  {
    href: "/dashboard/tools",
    label: "Tools",
    icon: "construction",
    match: "prefix",
    adminOnly: true,
  },
  // Analytics is hidden from the dashboard sidebar until the feature is ready.
  // {
  //   href: "/dashboard/analytics",
  //   label: "Analytics",
  //   icon: "analytics",
  //   match: "prefix",
  //   adminOnly: true,
  // },
  {
    href: "/dashboard/users",
    label: "User management",
    icon: "group",
    match: "prefix",
    adminOnly: true,
  },
];

function navActive(pathname: string, item: NavMain): boolean {
  if (item.match === "exact") return pathname === item.href;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { user, loading } = useAuth();
  const isAdmin = !!(user?.roles?.includes("tenant_admin"));

  useEffect(() => {
    if (!loading && !user) {
      router.replace("/login");
    }
  }, [loading, user, router]);

  const visibleMain = useMemo(
    () => MAIN_NAV.filter((n) => !n.adminOnly || isAdmin),
    [isAdmin],
  );

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

  const docActive = pathname === "/coming-soon/documentation" || pathname?.startsWith("/coming-soon/documentation/");
  const supportActive = pathname === "/coming-soon/support" || pathname?.startsWith("/coming-soon/support/");

  return (
    <div className="flex min-h-screen items-start bg-background font-sans text-on-surface">
      <aside className="sticky top-0 flex h-[100dvh] max-h-[100dvh] w-64 min-w-64 max-w-64 shrink-0 flex-col overflow-hidden border-r border-outline-variant bg-surface-container-low">
        <div className="shrink-0 px-6 pb-2 pt-6">
          <Link href="/dashboard" className="flex items-center gap-3 rounded-lg transition hover:opacity-95">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary">
              <MaterialSymbol name="shield" className="text-lg text-on-primary" filled />
            </div>
            <div className="min-w-0 text-left">
              <h2 className="leading-none font-black tracking-tighter text-on-surface">CipherStrike</h2>
              <p className="mt-1 text-[10px] font-bold uppercase tracking-widest text-outline">Offensive Security</p>
            </div>
          </Link>
        </div>

        <div className="shrink-0 px-6 pb-4 pt-2">
          <Link
            href="/dashboard/scan?new=1"
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary py-2.5 text-sm font-bold text-on-primary shadow-sm transition hover:opacity-90 active:scale-[0.99]"
          >
            <MaterialSymbol name="add" className="text-base text-on-primary" filled />
            Run Scan
          </Link>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-0 pb-2" aria-label="Main">
          <div className="flex flex-col">
            {visibleMain.map((item) => {
              const active = navActive(pathname, item);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    active
                      ? "flex items-center gap-3 border-r-4 border-primary bg-primary-container px-6 py-3 text-sm font-semibold text-on-primary-container transition-colors"
                      : "flex items-center gap-3 px-6 py-3 text-sm text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
                  }
                >
                  <MaterialSymbol
                    name={item.icon}
                    className={`text-xl shrink-0 ${active ? "text-on-primary-container" : "text-on-surface-variant"}`}
                    filled
                  />
                  {item.label}
                </Link>
              );
            })}
          </div>
        </nav>

        <div className="shrink-0 space-y-0 border-t border-outline-variant px-2 pb-3 pt-3">
          <Link
            href={`/coming-soon/documentation?${COMING_SOON_FROM_DASHBOARD_QUERY}`}
            className={
              docActive
                ? "flex items-center gap-3 rounded-lg bg-primary-container px-4 py-2 text-xs font-medium text-on-primary-container transition-colors"
                : "flex items-center gap-3 rounded-lg px-4 py-2 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
            }
          >
            <MaterialSymbol
              name="menu_book"
              className={`scale-90 text-lg ${docActive ? "text-on-primary-container" : ""}`}
              filled
            />
            Documentation
          </Link>
          <Link
            href={`/coming-soon/support?${COMING_SOON_FROM_DASHBOARD_QUERY}`}
            className={
              supportActive
                ? "mt-0.5 flex items-center gap-3 rounded-lg bg-primary-container px-4 py-2 text-xs font-medium text-on-primary-container transition-colors"
                : "mt-0.5 flex items-center gap-3 rounded-lg px-4 py-2 text-xs font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
            }
          >
            <MaterialSymbol
              name="help"
              className={`scale-90 text-lg ${supportActive ? "text-on-primary-container" : ""}`}
              filled
            />
            Support
          </Link>
        </div>
      </aside>

      <div className="flex min-h-screen min-w-0 flex-1 flex-col bg-background">
        <header className="sticky top-0 z-40 flex items-center justify-end border-b border-outline-variant bg-background/90 px-6 py-3 backdrop-blur-sm">
          <DashboardHeaderProfile user={user} />
        </header>
        <main className="min-h-full flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
