import { Suspense } from "react";
import type { Metadata } from "next";
import { CompleteRegistrationClient } from "./CompleteRegistrationClient";

export const metadata: Metadata = {
  title: "Complete registration | CipherStrike",
  description: "Set your password and enter the CipherStrike workspace.",
};

export default function CompleteRegistrationPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-surface-container-low font-sans text-on-surface">
          <p className="text-on-surface-variant">Loading…</p>
        </main>
      }
    >
      <CompleteRegistrationClient />
    </Suspense>
  );
}
