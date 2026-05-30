import type { Metadata } from "next";
import { DashboardRoleGuard } from "@/components/dashboard/DashboardRoleGuard";

export const metadata: Metadata = {
  title: "Workspace | Vrika",
};

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return <DashboardRoleGuard>{children}</DashboardRoleGuard>;
}
