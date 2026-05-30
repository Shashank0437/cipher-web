import { Suspense } from "react";
import type { Metadata } from "next";
import { InviteAcceptClient } from "@/components/invite/InviteAcceptClient";

export const metadata: Metadata = {
  title: "Invitation | Vrika",
};

export default function InviteAcceptPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-neutral-500">Loading…</div>}>
      <InviteAcceptClient />
    </Suspense>
  );
}
