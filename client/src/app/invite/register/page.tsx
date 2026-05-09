import { Suspense } from "react";
import type { Metadata } from "next";
import { InviteRegisterClient } from "@/components/invite/InviteRegisterClient";

export const metadata: Metadata = {
  title: "Complete invitation | CipherStrike",
};

export default function InviteRegisterPage() {
  return (
    <Suspense fallback={<div className="p-12 text-center text-neutral-500">Loading…</div>}>
      <InviteRegisterClient />
    </Suspense>
  );
}
