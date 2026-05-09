"use client";

import { InitializeOffensiveSequencePage } from "@/components/dashboard/InitializeOffensiveSequencePage";
import { useAuth } from "@/lib/auth-context";

export default function DashboardScanPage() {
  const { user } = useAuth();
  if (!user) {
    return null;
  }
  return <InitializeOffensiveSequencePage user={user} />;
}
