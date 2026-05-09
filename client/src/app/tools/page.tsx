import Link from "next/link";
import type { Metadata } from "next";
import { ToolsPageGate } from "@/components/tools/ToolsPageGate";

export const metadata: Metadata = {
  title: "Tools | CipherStrike",
  description:
    "Live tool registry availability from the CipherStrike-backed agent probe — proxied securely through our API.",
};

export default function ToolsPage() {
  return (
    <div className="min-h-dvh bg-background font-sans">
      <header className="sticky top-0 z-40 border-b border-outline-variant bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4 sm:px-6">
          <Link href="/" className="text-[14px] font-semibold text-primary hover:underline">
            ← Home
          </Link>
          <span className="text-on-surface-variant" aria-hidden>
            /
          </span>
          <span className="text-[14px] font-medium text-on-surface">Tool arsenal</span>
        </div>
      </header>
      <ToolsPageGate />
    </div>
  );
}
