import type { Metadata } from "next";
import { RequireDashboardUser } from "@/components/dashboard/RequireDashboardUser";

export const metadata: Metadata = {
  title: "Initialize sequence | Vrika",
};

export default function AgenticScanLayout({ children }: { children: React.ReactNode }) {
  return <RequireDashboardUser>{children}</RequireDashboardUser>;
}
