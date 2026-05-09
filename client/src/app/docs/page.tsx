import Link from "next/link";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Docs | CipherStrike",
};

export default function DocsPlaceholderPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-6 bg-background px-6 font-sans">
      <h1 className="text-2xl font-bold text-on-surface">Documentation</h1>
      <p className="max-w-md text-center text-on-surface-variant">Docs content will link from here once ported.</p>
      <Link href="/" className="font-bold text-primary hover:underline">
        ← Back home
      </Link>
    </main>
  );
}
