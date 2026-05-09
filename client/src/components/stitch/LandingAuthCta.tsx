"use client";

import Link from "next/link";
import { useAuth } from "@/lib/auth-context";

/** Hero CTA: Login when signed out; workspace when already authenticated (no auto-redirect from `/`). */
export function LandingHeroPrimaryCta({ className }: { className?: string }) {
  const { user, loading } = useAuth();
  const signedIn = !loading && !!user;
  return (
    <Link href={signedIn ? "/dashboard" : "/login"} className={className}>
      {signedIn ? "Open workspace" : "Login"}
    </Link>
  );
}

type AuthLinkProps = {
  href: string;
  /** Used when `user` is present (skip login shell). */
  signedInHref: string;
  className?: string;
  children: React.ReactNode;
};

export function LandingAuthLink({ href, signedInHref, className, children }: AuthLinkProps) {
  const { user, loading } = useAuth();
  const to = !loading && user ? signedInHref : href;
  return (
    <Link href={to} className={className}>
      {children}
    </Link>
  );
}
