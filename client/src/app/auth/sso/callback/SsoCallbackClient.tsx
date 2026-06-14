"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { setToken } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export function SsoCallbackClient() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { refreshUser } = useAuth();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const raw = searchParams.get("token")?.trim();
    if (!raw) {
      setError("Missing sign-in token. Try signing in again.");
      return;
    }
    const accessToken = raw;
    let cancelled = false;
    async function finish() {
      setToken(accessToken);
      try {
        await refreshUser();
        if (!cancelled) router.replace("/dashboard");
      } catch {
        if (!cancelled) setError("Could not complete SSO sign-in. Try again.");
      }
    }
    void finish();
    return () => {
      cancelled = true;
    };
  }, [searchParams, refreshUser, router]);

  return (
    <AuthSplitLayout>
      <div className="mx-auto max-w-[400px] text-center">
        {error ? (
          <>
            <h1 className="text-2xl font-semibold text-neutral-900">Sign-in failed</h1>
            <p className="mt-3 text-[15px] text-neutral-500">{error}</p>
          </>
        ) : (
          <p className="text-sm text-neutral-500">Completing sign-in…</p>
        )}
      </div>
    </AuthSplitLayout>
  );
}
