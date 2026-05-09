import { Suspense } from "react";
import { DashboardUsersManagement } from "@/components/dashboard/DashboardUsersManagement";

export default function DashboardUsersPage() {
  return (
    <Suspense fallback={<div className="p-10 text-center text-on-surface-variant">Loading…</div>}>
      <DashboardUsersManagement />
    </Suspense>
  );
}
