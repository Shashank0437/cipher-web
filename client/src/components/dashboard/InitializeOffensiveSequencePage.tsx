"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { DashboardHeaderProfile } from "@/components/dashboard/DashboardHeaderProfile";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { AuthUser } from "@/lib/auth-context";

type QuickCard = {
  id: string;
  title: string;
  description: string;
  icon: string;
  promptSeed: string;
};

const QUICK_CARDS: QuickCard[] = [
  {
    id: "recon",
    title: "Recon my domain",
    description: "Passive OSINT and sub-domain enumeration",
    icon: "travel_explore",
    promptSeed: "Run passive OSINT and subdomain enumeration on ",
  },
  {
    id: "cve",
    title: "Analyze target for CVEs",
    description: "Version detection and vulnerability mapping",
    icon: "shield_lock",
    promptSeed: "Analyze the target for CVEs — version detection and vulnerability mapping for ",
  },
  {
    id: "sqli",
    title: "Craft SQLi Payload",
    description: "Tailored bypass strings for specific DB engines",
    icon: "code",
    promptSeed: "Craft tailored SQL injection payloads for MySQL for ",
  },
  {
    id: "network",
    title: "Network Scan",
    description: "Stealth port scanning and service fingerprinting",
    icon: "radar",
    promptSeed: "Run a stealth port scan and service fingerprinting against ",
  },
];

export function InitializeOffensiveSequencePage({ user }: { user: AuthUser }) {
  const [prompt, setPrompt] = useState("");

  const onCardClick = useCallback((seed: string) => {
    setPrompt((p) => (p.trim() ? `${p.trim()}\n${seed}` : seed));
  }, []);

  return (
    <div className="flex min-h-[100dvh] flex-col bg-background font-sans text-on-surface md:flex-row">
      {/* Mobile top bar */}
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-outline-variant bg-surface-container-low px-4 py-3 md:hidden">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-2 text-sm font-semibold text-on-surface-variant"
        >
          <MaterialSymbol name="arrow_back" className="text-xl text-primary" filled />
          Dashboard
        </Link>
        <span className="truncate text-xs font-bold uppercase tracking-wide text-primary">Agentic</span>
      </div>

      {/* Sidebar — desktop */}
      <aside className="hidden w-[272px] min-w-[272px] shrink-0 flex-col border-r border-outline-variant bg-surface-container-low md:flex">
        <div className="shrink-0 px-5 pb-2 pt-6">
          <Link
            href="/dashboard"
            className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            <MaterialSymbol name="arrow_back" className="text-xl text-primary" filled />
            Go to Dashboard
          </Link>
        </div>

        <div className="min-h-0 flex-1 px-5 pt-4">
          <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-primary">Recent chats</p>
          <div className="mt-4 rounded-xl border border-dashed border-outline-variant/80 bg-surface-container-lowest/80 px-4 py-8 text-center">
            <p className="text-[13px] leading-relaxed text-on-surface-variant">
              No chats yet. Start with New chat below.
            </p>
          </div>
        </div>

        <div className="shrink-0 border-t border-outline-variant/80 p-5">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-on-primary shadow-sm transition hover:opacity-92 active:scale-[0.99]"
            onClick={() => setPrompt("")}
          >
            <MaterialSymbol name="edit_square" className="text-lg text-on-primary" filled />
            New chat
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-40 flex shrink-0 items-start justify-between gap-4 border-b border-outline-variant bg-background/95 px-6 py-4 backdrop-blur-sm">
          <div className="min-w-0 pt-0.5">
            <h1 className="text-lg font-black leading-tight tracking-tight text-on-surface md:text-xl">
              CipherStrike{" "}
              <span className="font-bold text-on-surface-variant">| Agentic Workspace</span>
            </h1>
            <p className="mt-1 text-[12px] text-on-surface-variant md:text-[13px]">
              CipherStrike v1.0.0 — Offensive AI Subsystem
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <div className="hidden items-center gap-2 rounded-full border border-outline-variant bg-surface-container-lowest px-3 py-1.5 sm:flex">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400/70 opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              <span className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
                System health: nominal
              </span>
            </div>
            <DashboardHeaderProfile user={user} />
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col">
          <div className="mx-auto flex w-full max-w-[720px] flex-1 flex-col px-6 pb-[220px] pt-10 md:px-8">
            <div className="flex flex-col items-center text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-container shadow-sm ring-1 ring-primary/15">
                <MaterialSymbol name="hub" className="text-3xl text-primary" filled />
              </div>
              <h2 className="mt-6 text-2xl font-bold tracking-tight text-on-surface md:text-[1.65rem]">
                Initialize Offensive Sequence
              </h2>
              <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-on-surface-variant">
                Deploy specialized agents to perform deep reconnaissance, vulnerability analysis, or automated exploit
                crafting.
              </p>
            </div>

            <div className="mt-10 grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
              {QUICK_CARDS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => onCardClick(c.promptSeed)}
                  className="group flex gap-4 rounded-2xl border border-outline-variant bg-surface-container-lowest p-4 text-left shadow-sm transition hover:border-primary/35 hover:shadow-md"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-container/90 text-primary ring-1 ring-primary/10">
                    <MaterialSymbol name={c.icon} className="text-2xl" filled />
                  </div>
                  <div className="min-w-0">
                    <p className="font-bold text-on-surface">{c.title}</p>
                    <p className="mt-1 text-[13px] leading-snug text-on-surface-variant">{c.description}</p>
                  </div>
                </button>
              ))}
            </div>

            <p className="mt-8 text-center text-[13px] text-on-surface-variant">
              Use <span className="font-semibold text-primary">@</span> in the prompt for agents &amp; tools, or the{" "}
              <span className="font-semibold text-on-surface">@ Agent</span> /{" "}
              <span className="font-semibold text-on-surface">+ Tool</span> buttons — then Execute.
            </p>
          </div>

          {/* Bottom composer (pinned above footer line) */}
          <div className="pointer-events-none fixed bottom-10 left-0 right-0 z-30 px-4 md:bottom-10 md:left-[272px] md:px-10">
            <div className="pointer-events-auto mx-auto max-w-[720px] rounded-2xl border border-outline-variant bg-surface-container-lowest p-4 shadow-[0_8px_40px_-12px_rgba(104,76,182,0.22)] ring-1 ring-black/[0.03]">
              <label htmlFor="offensive-prompt" className="sr-only">
                Offensive security prompt
              </label>
              <textarea
                id="offensive-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Enter offensive security prompt or tactical objective… Type @ for agents & tools"
                className="w-full resize-none rounded-xl border-0 bg-transparent px-1 py-1 text-[15px] leading-relaxed text-on-surface placeholder:text-on-surface-variant/70 focus:outline-none focus:ring-0"
              />
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-outline-variant/80 pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 text-[13px] font-semibold text-on-surface transition hover:bg-surface-container"
                  >
                    <MaterialSymbol name="person_raised_hand" className="text-lg text-on-surface-variant" />
                    @ Agent
                  </button>
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 text-[13px] font-semibold text-on-surface transition hover:bg-surface-container"
                  >
                    <MaterialSymbol name="build" className="text-lg text-on-surface-variant" />
                    + Tool
                  </button>
                </div>
                <button
                  type="button"
                  className="inline-flex items-center gap-2 rounded-full bg-surface-container-highest px-5 py-2.5 text-sm font-bold uppercase tracking-wide text-on-surface-variant shadow-inner transition hover:bg-surface-variant disabled:cursor-not-allowed"
                  disabled={!prompt.trim()}
                >
                  <MaterialSymbol name="bolt" className="text-xl text-on-surface-variant" filled />
                  Execute
                </button>
              </div>
            </div>
          </div>

          <footer className="pointer-events-none fixed bottom-0 left-0 right-0 z-20 border-t border-transparent bg-gradient-to-t from-background via-background to-transparent py-3 text-center text-[10px] font-bold uppercase tracking-[0.28em] text-on-surface-variant/80 md:left-[272px]">
            Hexstrike agentic framework v2.4.0-stable
          </footer>
        </div>
      </div>
    </div>
  );
}
