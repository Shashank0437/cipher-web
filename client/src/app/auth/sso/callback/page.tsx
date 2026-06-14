import { Suspense } from "react";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { SsoCallbackClient } from "./SsoCallbackClient";

export default function SsoCallbackPage() {
  return (
    <Suspense
      fallback={
        <AuthSplitLayout>
          <p className="text-center text-sm text-neutral-500">Completing sign-in…</p>
        </AuthSplitLayout>
      }
    >
      <SsoCallbackClient />
    </Suspense>
  );
}
