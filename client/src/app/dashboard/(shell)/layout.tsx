import { DashboardShell } from "@/components/dashboard/DashboardShell";

export default function DashboardShellLayout({ children }: { children: React.ReactNode }) {
  return <DashboardShell>{children}</DashboardShell>;
}
