"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useState } from "react";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

const inputCls =
  "mt-2 h-11 w-full rounded-lg border border-neutral-200 bg-white px-3.5 text-[15px] text-neutral-900 outline-none transition-[border,box-shadow] placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900";
const labelCls = "text-[13px] font-medium text-neutral-600";

export function CompleteRegistrationClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get("token") ?? "";
  const { user, loading, completeRegistration } = useAuth();

  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!loading && user) {
      router.replace("/dashboard");
    }
  }, [loading, user, router]);

  if (loading || user) {
    return (
      <AuthSplitLayout>
        <p className="text-center text-sm text-neutral-500">Loading…</p>
      </AuthSplitLayout>
    );
  }

  if (!token.trim()) {
    return (
      <AuthSplitLayout>
        <div className="mx-auto max-w-[400px]">
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">Invalid or expired link</h1>
          <p className="mt-3 text-[15px] leading-relaxed text-neutral-500">
            Open the completion link from your approval email, or request access again from sign-in.
          </p>
          <Link
            href="/login"
            className="mt-8 inline-flex h-12 items-center justify-center rounded-lg bg-neutral-900 px-6 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800"
          >
            Go to sign in
          </Link>
        </div>
      </AuthSplitLayout>
    );
  }

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await completeRegistration(token.trim(), password);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not complete registration");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <AuthSplitLayout>
      <div className="mx-auto w-full max-w-[400px]">
        <header className="mb-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-primary">CipherStrike</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-900 sm:text-[1.75rem]">Create your password</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-500">
            You’re approved—choose a strong password to activate your organization workspace.
          </p>
        </header>

        {error ? (
          <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-5">
          <div>
            <label className={labelCls} htmlFor="pw">
              New password
            </label>
            <input
              id="pw"
              name="password"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputCls}
            />
          </div>
          <div>
            <label className={labelCls} htmlFor="pw2">
              Confirm password
            </label>
            <input
              id="pw2"
              name="confirm"
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className={inputCls}
            />
          </div>
          <button
            type="submit"
            disabled={submitting}
            className="mt-1 h-12 w-full rounded-lg bg-neutral-900 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
          >
            {submitting ? "Activating…" : "Activate workspace"}
          </button>
        </form>

        <p className="mt-10 text-center text-xs leading-relaxed text-neutral-500">
          <Link
            href="/login"
            className="font-medium text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900"
          >
            ← Back to sign in
          </Link>
        </p>
      </div>
    </AuthSplitLayout>
  );
}
