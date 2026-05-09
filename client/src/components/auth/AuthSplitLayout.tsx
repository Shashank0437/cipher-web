import type { ReactNode } from "react";
import { AuthMarketingPanel } from "./AuthMarketingPanel";

type AuthSplitLayoutProps = {
  children: ReactNode;
};

/** Desktop: reference-style split — marketing left, minimal white form column right. */
export function AuthSplitLayout({ children }: AuthSplitLayoutProps) {
  return (
    <div className="flex min-h-dvh flex-col bg-white font-sans text-neutral-900 lg:flex-row">
      <AuthMarketingPanel />
      <section className="flex flex-1 flex-col justify-center px-6 py-12 sm:px-10 lg:px-16 xl:px-20">{children}</section>
    </div>
  );
}
