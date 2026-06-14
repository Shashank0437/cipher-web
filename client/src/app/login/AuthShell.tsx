"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { AuthSplitLayout } from "@/components/auth/AuthSplitLayout";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

type Mode = "login" | "register";

const inputCls =
  "mt-2 h-11 w-full rounded-lg border border-neutral-200 bg-white px-3.5 text-[15px] text-neutral-900 outline-none transition-[border,box-shadow] placeholder:text-neutral-400 focus:border-neutral-900 focus:ring-1 focus:ring-neutral-900";
const labelCls = "text-[13px] font-medium text-neutral-600";

export function AuthShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, loading, login, registerRequest, discoverSso, startSsoLogin } = useAuth();

  const qMode = searchParams.get("mode");
  const [mode, setMode] = useState<Mode>(qMode === "register" ? "register" : "login");

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [registerDone, setRegisterDone] = useState(false);
  const [ssoRequired, setSsoRequired] = useState(false);
  const [ssoAvailable, setSsoAvailable] = useState(false);
  const [ssoProvider, setSsoProvider] = useState("");
  const [discoveringSso, setDiscoveringSso] = useState(false);

  const nextRaw = searchParams.get("next");
  const safeRedirect = useMemo(() => {
    if (!nextRaw || !nextRaw.startsWith("/") || nextRaw.startsWith("//")) return "/dashboard";
    return nextRaw;
  }, [nextRaw]);

  useEffect(() => {
    if (!loading && user) {
      router.replace(safeRedirect);
    }
  }, [loading, user, router, safeRedirect]);

  useEffect(() => {
    if (qMode === "register") setMode("register");
    if (qMode === "login") setMode("login");
  }, [qMode]);

  useEffect(() => {
    const ssoError = searchParams.get("sso_error");
    if (ssoError) {
      setError(decodeURIComponent(ssoError));
    }
  }, [searchParams]);

  useEffect(() => {
    if (mode !== "login") return;
    const trimmed = email.trim();
    if (!trimmed.includes("@")) {
      setSsoRequired(false);
      setSsoAvailable(false);
      setSsoProvider("");
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setDiscoveringSso(true);
      void discoverSso(trimmed)
        .then((res) => {
          if (cancelled) return;
          setSsoRequired(res.sso_required);
          setSsoAvailable(res.sso_available);
          setSsoProvider(res.provider_display_name);
        })
        .catch(() => {
          if (!cancelled) {
            setSsoRequired(false);
            setSsoAvailable(false);
            setSsoProvider("");
          }
        })
        .finally(() => {
          if (!cancelled) setDiscoveringSso(false);
        });
    }, 400);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [email, mode, discoverSso]);

  if (loading || user) {
    return (
      <AuthSplitLayout>
        <p className="text-center text-sm text-neutral-500">Loading…</p>
      </AuthSplitLayout>
    );
  }

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (ssoRequired) {
      startSsoLogin(email);
      return;
    }
    setSubmitting(true);
    try {
      await login(email, password, safeRedirect);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Sign-in failed");
    } finally {
      setSubmitting(false);
    }
  };

  const onSsoLogin = () => {
    setError(null);
    startSsoLogin(email);
  };

  const onRegister = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await registerRequest({
        email,
        username,
        company_name: companyName,
        phone,
      });
      setRegisterDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not submit registration");
    } finally {
      setSubmitting(false);
    }
  };

  const tabBtn = (active: boolean) =>
    `rounded-md py-2.5 text-sm font-medium transition-all ${
      active ? "bg-white text-neutral-900 shadow-sm" : "text-neutral-500 hover:text-neutral-700"
    }`;

  return (
    <AuthSplitLayout>
      <div className="mx-auto w-full max-w-[400px]">
        <header className="mb-8">
          <p className="text-[11px] font-bold uppercase tracking-[0.28em] text-primary">Workspace</p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-neutral-900 sm:text-[1.75rem]">Access your account</h1>
          <p className="mt-2 text-[15px] leading-relaxed text-neutral-500">
            Business registrations are reviewed before activation.
          </p>
        </header>

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-neutral-100 p-1">
          <button
            type="button"
            onClick={() => {
              setMode("login");
              setError(null);
              setRegisterDone(false);
            }}
            className={tabBtn(mode === "login")}
          >
            Sign in
          </button>
          <button
            type="button"
            onClick={() => {
              setMode("register");
              setError(null);
              setRegisterDone(false);
            }}
            className={tabBtn(mode === "register")}
          >
            Request access
          </button>
        </div>

        <div className="mt-8">
          {error ? (
            <div className="mb-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
          ) : null}

          {mode === "login" ? (
            <form onSubmit={onLogin} className="space-y-5">
              <div>
                <label className={labelCls} htmlFor="email">
                  Work email
                </label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </div>
              {!ssoRequired ? (
                <div>
                  <label className={labelCls} htmlFor="password">
                    Password
                  </label>
                  <input
                    id="password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required={!ssoAvailable}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={inputCls}
                  />
                </div>
              ) : null}
              {ssoRequired ? (
                <p className="text-[13px] leading-relaxed text-neutral-500">
                  Your organization uses single sign-on. Continue with your corporate identity provider.
                </p>
              ) : null}
              {ssoRequired ? (
                <button
                  type="button"
                  onClick={onSsoLogin}
                  disabled={discoveringSso || !email.trim()}
                  className="mt-2 h-12 w-full rounded-lg bg-neutral-900 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
                >
                  {discoveringSso ? "Checking…" : `Sign in with ${ssoProvider || "SSO"}`}
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={submitting}
                  className="mt-2 h-12 w-full rounded-lg bg-neutral-900 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
                >
                  {submitting ? "Signing in…" : "Sign in"}
                </button>
              )}
              {!ssoRequired && ssoAvailable ? (
                <button
                  type="button"
                  onClick={onSsoLogin}
                  disabled={discoveringSso || !email.trim()}
                  className="h-11 w-full rounded-lg border border-neutral-200 bg-white text-[15px] font-semibold text-neutral-800 transition-colors hover:bg-neutral-50 disabled:opacity-50"
                >
                  {`Sign in with ${ssoProvider || "SSO"}`}
                </button>
              ) : null}
            </form>
          ) : registerDone ? (
            <div className="rounded-2xl border border-neutral-200/80 bg-neutral-50/80 px-6 py-10 text-center">
              <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-emerald-50 ring-1 ring-emerald-100">
                <MaterialSymbol name="check_circle" filled className="text-3xl text-emerald-700" />
              </div>
              <p className="mt-5 text-lg font-semibold text-neutral-900">Check your email</p>
              <p className="mt-2 text-[15px] leading-relaxed text-neutral-500">
                When your request is approved, you’ll get a secure link to create your password and activate your organization
                workspace.
              </p>
            </div>
          ) : (
            <form onSubmit={onRegister} className="space-y-5">
              <div>
                <label className={labelCls} htmlFor="bemail">
                  Business email
                </label>
                <input
                  id="bemail"
                  name="bemail"
                  type="email"
                  autoComplete="email"
                  placeholder="name@company.com"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="username">
                  Username
                </label>
                <input
                  id="username"
                  name="username"
                  type="text"
                  autoComplete="name"
                  required
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="company">
                  Company
                </label>
                <input
                  id="company"
                  name="company"
                  type="text"
                  autoComplete="organization"
                  required
                  value={companyName}
                  onChange={(e) => setCompanyName(e.target.value)}
                  className={inputCls}
                />
              </div>
              <div>
                <label className={labelCls} htmlFor="phone">
                  Phone number
                </label>
                <input
                  id="phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={inputCls}
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-1 h-12 w-full rounded-lg bg-neutral-900 text-[15px] font-semibold text-white transition-colors hover:bg-neutral-800 disabled:opacity-50"
              >
                {submitting ? "Submitting…" : "Submit request"}
              </button>
            </form>
          )}
        </div>

        <p className="mt-10 text-center text-xs leading-relaxed text-neutral-500">
          By continuing you agree to our{" "}
          <Link href="/terms-of-use" className="font-medium text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900">
            Terms of Use
          </Link>{" "}
          and{" "}
          <Link href="/privacy-policy" className="font-medium text-neutral-700 underline decoration-neutral-300 underline-offset-2 hover:text-neutral-900">
            Privacy Policy
          </Link>
          .
        </p>
      </div>
    </AuthSplitLayout>
  );
}
