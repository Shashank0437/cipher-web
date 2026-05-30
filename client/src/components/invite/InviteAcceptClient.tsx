"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { ApiError, apiPublic, clearToken } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

type InvitePreview = {
  organization_name: string;
  inviter_display: string;
  invitee_email: string;
  invitee_username: string;
};

export function InviteAcceptClient() {
  const searchParams = useSearchParams();
  const token = searchParams.get("token")?.trim() ?? "";
  const { user, loading } = useAuth();
  const [data, setData] = useState<InvitePreview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [fetching, setFetching] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      if (!token) {
        setErr("Invalid invitation link.");
        setFetching(false);
        return;
      }
      try {
        const d = await apiPublic<InvitePreview>(
          `/invitations/preview?token=${encodeURIComponent(token)}`,
        );
        if (!cancelled) {
          setData(d);
          setErr(null);
        }
      } catch (e) {
        if (!cancelled) setErr(e instanceof ApiError ? e.message : "This invitation link is invalid or expired.");
      } finally {
        if (!cancelled) setFetching(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const registerHref =
    token && !err ? `/invite/register?token=${encodeURIComponent(token)}` : "";

  if (!token.trim()) {
    return (
      <AuthSplitLayout>
        <InviteInvalidFallback />
      </AuthSplitLayout>
    );
  }

  if (fetching || loading) {
    return (
      <AuthSplitLayout>
        <div className="mx-auto flex max-w-[440px] flex-col gap-8 text-center lg:text-left">
          <p className="text-neutral-500">Loading invitation…</p>
        </div>
      </AuthSplitLayout>
    );
  }

  if (err || !data) {
    return (
      <AuthSplitLayout>
        <div className="mx-auto flex max-w-[440px] flex-col gap-6">
          <div className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-red-50 ring-1 ring-red-100 lg:mx-0">
            <MaterialSymbol name="link_off" className="text-3xl text-red-600" filled />
          </div>
          <div>
            <h1 className="text-[1.65rem] font-bold tracking-tight text-neutral-900">Invitation unavailable</h1>
            <p className="mt-3 leading-relaxed text-neutral-600">{err}</p>
          </div>
          <Link
            href="/login"
            className="inline-flex h-12 items-center justify-center rounded-xl bg-neutral-900 text-[15px] font-semibold text-white hover:bg-neutral-800"
          >
            Go to sign in
          </Link>
        </div>
      </AuthSplitLayout>
    );
  }

  return (
    <AuthSplitLayout>
      <div className="relative mx-auto w-full max-w-[440px]">
        <span className="pointer-events-none absolute -right-28 -top-16 hidden size-72 rounded-full bg-gradient-to-bl from-purple-400/35 via-purple-600/25 to-transparent blur-2xl xl:block" />
        <span className="pointer-events-none absolute -left-20 top-56 hidden size-64 rounded-full bg-gradient-to-tr from-cyan-300/35 to-transparent blur-2xl lg:block" />
        <div className="relative rounded-[1.65rem] border border-purple-500/25 bg-[linear-gradient(135deg,#f9f8ff,#ffffff)] px-8 py-10 shadow-[0_20px_50px_-12px_rgba(104,76,182,0.25)] backdrop-blur">
          <div className="inline-flex rounded-full bg-primary-container px-3 py-1 text-[11px] font-bold uppercase tracking-wider text-on-primary-container">
            Vrika invite
          </div>
          <h1 className="mt-5 text-[1.75rem] font-bold leading-snug tracking-tight text-neutral-900">
            <span className="text-purple-950">{data.inviter_display}</span>
            {" invited "}
            <span className="text-purple-800">{data.invitee_username}</span>
          </h1>
          <p className="mt-5 text-[16px] leading-relaxed text-neutral-600">
            Join <strong className="text-neutral-900">{data.organization_name}</strong> — review security operations and
            session history alongside your teammates.
          </p>
          <p className="mt-6 inline-flex gap-3 rounded-xl border border-neutral-800/14 bg-neutral-900/[0.04] px-4 py-3 text-[13px] text-neutral-600">
            <MaterialSymbol name="alternate_email" className="mt-px shrink-0 text-lg text-primary" />
            <span>This invite is tied to&nbsp;{data.invitee_email}</span>
          </p>

          {user ? (
            <div className="mt-8 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[13px] font-medium leading-relaxed text-amber-950">
              You are signed in as <strong>{user.email}</strong>. If that is not the invited address above,{" "}
              <button
                type="button"
                onClick={() => {
                  clearToken();
                  window.location.assign(`/invite/accept?token=${encodeURIComponent(token)}`);
                }}
                className="font-bold text-purple-950 underline underline-offset-2 hover:text-purple-900"
              >
                sign out and continue this invite
              </button>
              .
            </div>
          ) : null}

          <Link
            href={registerHref}
            className="mt-9 flex h-[3.125rem] w-full items-center justify-center gap-2 rounded-full bg-neutral-900 text-[15px] font-bold text-white shadow-lg shadow-purple-600/35 transition-colors hover:bg-neutral-800"
          >
            Accept invitation
            <MaterialSymbol name="arrow_forward" className="text-lg" filled />
          </Link>
          <p className="mt-8 text-center text-[12px] leading-relaxed text-neutral-400 lg:text-left">
            By continuing you create a Vrika workspace account under this organization&apos;s tenancy.
          </p>
        </div>
      </div>
    </AuthSplitLayout>
  );
}

function InviteInvalidFallback() {
  return (
    <div className="mx-auto flex max-w-[440px] flex-col gap-6">
      <h1 className="text-[1.65rem] font-bold tracking-tight text-neutral-900">Missing invitation token</h1>
      <p className="leading-relaxed text-neutral-600">Open this page from your email invitation link.</p>
      <Link href="/login" className="inline-flex h-12 items-center justify-center rounded-xl bg-neutral-900 font-semibold text-white">
        Sign in
      </Link>
    </div>
  );
}
