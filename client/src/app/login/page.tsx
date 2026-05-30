import { Suspense } from "react";
import type { Metadata } from "next";
import { AuthShell } from "./AuthShell";

export const metadata: Metadata = {
  title: "Sign in | Vrika",
  description: "Sign in or request access to the Vrika workspace.",
};

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <main className="flex min-h-dvh items-center justify-center bg-surface-container-low font-sans text-on-surface">
          <p className="text-on-surface-variant">Loading…</p>
        </main>
      }
    >
      <AuthShell />
    </Suspense>
  );
}
