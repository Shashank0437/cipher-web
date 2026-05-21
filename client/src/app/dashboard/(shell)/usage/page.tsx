"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { listAgentChatSessions, type AgentChatSession } from "@/lib/agentChat";

function sxId(sessionId: string): string {
  return `#SX-${sessionId.replace(/[^a-fA-F0-9]/g, "").slice(-5).toUpperCase() || "00000"}`;
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function formatNumber(num: number): string {
  return new Intl.NumberFormat().format(num);
}

export default function UsagePage() {
  const [sessions, setSessions] = useState<AgentChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState<"newest" | "oldest" | "tokens-desc" | "calls-desc">("newest");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const data = await listAgentChatSessions();
      setSessions(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    load();
    const timer = window.setInterval(() => load(true), 5000);
    return () => window.clearInterval(timer);
  }, []);

  // Compute aggregated stats
  const stats = useMemo(() => {
    let totalInput = 0;
    let totalOutput = 0;
    let totalCalls = 0;

    sessions.forEach((s) => {
      totalInput += s.input_tokens ?? 0;
      totalOutput += s.output_tokens ?? 0;
      totalCalls += s.num_calls ?? 0;
    });

    const grandTotal = totalInput + totalOutput;

    return {
      totalInput,
      totalOutput,
      grandTotal,
      totalCalls,
    };
  }, [sessions]);

  // Filter & sort sessions
  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = sessions.filter((s) => {
      if (!q) return true;
      const haystack = [
        s.title,
        sxId(s.id),
        s.id,
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });

    return [...filtered].sort((a, b) => {
      if (sortMode === "newest") {
        const da = new Date(a.created_at).getTime() || 0;
        const db = new Date(b.created_at).getTime() || 0;
        return db - da;
      }
      if (sortMode === "oldest") {
        const da = new Date(a.created_at).getTime() || 0;
        const db = new Date(b.created_at).getTime() || 0;
        return da - db;
      }
      if (sortMode === "tokens-desc") {
        const ta = (a.input_tokens ?? 0) + (a.output_tokens ?? 0);
        const tb = (b.input_tokens ?? 0) + (b.output_tokens ?? 0);
        return tb - ta;
      }
      if (sortMode === "calls-desc") {
        const ca = a.num_calls ?? 0;
        const cb = b.num_calls ?? 0;
        return cb - ca;
      }
      return 0;
    });
  }, [sessions, query, sortMode]);

  const cards = [
    {
      label: "Total Tokens",
      value: formatNumber(stats.grandTotal),
      sub: "Across all chat operations",
      icon: "generating_tokens",
      iconWrap: "bg-primary-container text-primary",
    },
    {
      label: "Input Tokens",
      value: formatNumber(stats.totalInput),
      sub: `${stats.grandTotal > 0 ? Math.round((stats.totalInput / stats.grandTotal) * 100) : 0}% of consumption`,
      icon: "login",
      iconWrap: "bg-primary-container text-tertiary",
    },
    {
      label: "Output Tokens",
      value: formatNumber(stats.totalOutput),
      sub: `${stats.grandTotal > 0 ? Math.round((stats.totalOutput / stats.grandTotal) * 100) : 0}% of consumption`,
      icon: "logout",
      iconWrap: "bg-primary-container text-primary",
    },
    {
      label: "LLM Interactions",
      value: formatNumber(stats.totalCalls),
      sub: stats.totalCalls === 1 ? "1 API completion call" : `${formatNumber(stats.totalCalls)} API completion calls`,
      icon: "smart_toy",
      iconWrap: "bg-primary-container text-tertiary",
    },
  ];

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-10 pb-20">
      <header className="mb-10">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Usage</p>
        <h1 className="mt-2 text-[1.85rem] font-bold tracking-tight text-on-surface">LLM Token Usage</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-on-surface-variant">
          Monitor and audit precise token usage and LLM API call metrics per chat session in real time.
        </p>
      </header>

      {/* Overview Cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((c) => (
          <div
            key={c.label}
            className="rounded-2xl border border-outline-variant bg-surface px-5 py-4.5 shadow-sm transition-all hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-on-surface-variant">{c.label}</p>
                <p className="mt-2 text-2.5xl font-bold tracking-tight text-on-surface">{c.value}</p>
                <p className="mt-1.5 text-[12px] text-on-surface-variant">{c.sub}</p>
              </div>
              <span className={`flex size-11 shrink-0 items-center justify-center rounded-xl ${c.iconWrap}`}>
                <MaterialSymbol name={c.icon} className="text-[22px]" filled />
              </span>
            </div>
          </div>
        ))}
      </div>

      {/* Accordion List Container */}
      <div className="mt-10 rounded-2xl border border-outline-variant bg-surface shadow-sm">
        {/* Filter Bar */}
        <div className="flex flex-col gap-4 border-b border-outline-variant px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block max-w-xl flex-1">
            <MaterialSymbol
              name="search"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search chat session by title or ID…"
              className="h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-2.5 pr-3 pl-11 text-[15px] text-on-surface outline-none transition-[border-color,box-shadow] placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <div className="inline-flex items-center gap-1.5 rounded-xl border border-outline-variant bg-surface-container-lowest px-3 py-1.5 text-[13px]">
              <span className="text-on-surface-variant font-medium">Sort:</span>
              <select
                value={sortMode}
                onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
                className="bg-transparent font-semibold text-on-surface outline-none cursor-pointer"
              >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="tokens-desc">Highest Tokens</option>
                <option value="calls-desc">Most LLM Calls</option>
              </select>
            </div>
          </div>
        </div>

        {error ? (
          <div className="border-b border-outline-variant px-5 py-3 text-[13px] font-semibold text-red-700">
            {error}
          </div>
        ) : null}

        {/* Sessions Accordion */}
        <div className="divide-y divide-outline-variant/60">
          {loading && sessions.length === 0 ? (
            <div className="px-5 py-12 text-center text-on-surface-variant text-[14px]">
              Loading sessions usage data…
            </div>
          ) : filteredSessions.length === 0 ? (
            <div className="px-5 py-12 text-center">
              <div className="mx-auto max-w-md">
                <MaterialSymbol name="analytics" className="text-4xl text-primary" />
                <p className="mt-3 text-[15px] font-bold text-on-surface">No chat sessions found</p>
                <p className="mt-1 text-[13px] text-on-surface-variant">
                  Start a new security scan chat turn to record token usage statistics.
                </p>
                <Link
                  href="/dashboard/scan?new=1"
                  className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-bold text-on-primary hover:opacity-90"
                >
                  <MaterialSymbol name="add" className="text-base text-on-primary" filled />
                  Start scan
                </Link>
              </div>
            </div>
          ) : (
            filteredSessions.map((session) => {
              const promptTokens = session.input_tokens ?? 0;
              const completionTokens = session.output_tokens ?? 0;
              const totalTokens = promptTokens + completionTokens;
              const calls = session.num_calls ?? 0;
              const isExpanded = expandedId === session.id;

              // Calculate percentages for visual ratio split bar
              const promptPercent = totalTokens > 0 ? (promptTokens / totalTokens) * 100 : 0;
              const completionPercent = totalTokens > 0 ? (completionTokens / totalTokens) * 100 : 0;

              return (
                <div
                  key={session.id}
                  className={`transition-colors duration-150 ${
                    isExpanded ? "bg-primary-container/[0.04]" : "hover:bg-primary-container/[0.02]"
                  }`}
                >
                  {/* Accordion Trigger Header */}
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : session.id)}
                    className="flex w-full items-center justify-between gap-4 px-5 py-4.5 text-left outline-none"
                  >
                    <div className="flex-1 min-w-0 grid gap-4 md:grid-cols-12 md:items-center">
                      {/* Title and ID */}
                      <div className="md:col-span-5 min-w-0">
                        <p className="font-semibold text-on-surface truncate text-[14px]">
                          {session.title || "Chat Session"}
                        </p>
                        <p className="text-[12px] text-on-surface-variant mt-0.5 font-mono">
                          {sxId(session.id)}
                        </p>
                      </div>

                      {/* Split Ratio Bar */}
                      <div className="md:col-span-4 hidden md:block">
                        <div className="flex items-center justify-between text-[11px] text-on-surface-variant mb-1 font-semibold">
                          <span>Prompt ({Math.round(promptPercent)}%)</span>
                          <span>Completion ({Math.round(completionPercent)}%)</span>
                        </div>
                        <div className="h-2 w-full rounded-full bg-surface-container-high overflow-hidden flex">
                          <div
                            style={{ width: `${promptPercent}%` }}
                            className="bg-primary/85 h-full transition-all"
                            title={`Prompt: ${formatNumber(promptTokens)} tokens`}
                          />
                          <div
                            style={{ width: `${completionPercent}%` }}
                            className="bg-tertiary h-full transition-all"
                            title={`Completion: ${formatNumber(completionTokens)} tokens`}
                          />
                        </div>
                      </div>

                      {/* Total Tokens and Calls */}
                      <div className="md:col-span-3 flex items-center justify-end gap-6 text-[13px] text-right">
                        <div>
                          <p className="font-bold text-on-surface text-[14px]">{formatNumber(totalTokens)}</p>
                          <p className="text-[11px] text-on-surface-variant uppercase font-bold tracking-wider mt-0.5">Tokens</p>
                        </div>
                        <div className="min-w-[60px]">
                          <p className="font-bold text-on-surface text-[14px]">{formatNumber(calls)}</p>
                          <p className="text-[11px] text-on-surface-variant uppercase font-bold tracking-wider mt-0.5">Calls</p>
                        </div>
                      </div>
                    </div>

                    <div className="text-on-surface-variant transition-transform shrink-0">
                      <MaterialSymbol
                        name={isExpanded ? "expand_less" : "expand_more"}
                        className="text-xl"
                      />
                    </div>
                  </button>

                  {/* Accordion Content Panel */}
                  {isExpanded ? (
                    <div className="border-t border-outline-variant/40 bg-surface-container/20 px-5 py-5 text-[13px]">
                      {/* Responsive Split Bar for Mobile only */}
                      <div className="block md:hidden mb-5">
                        <p className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant mb-2">Token ratio split</p>
                        <div className="h-2.5 w-full rounded-full bg-surface-container-high overflow-hidden flex">
                          <div
                            style={{ width: `${promptPercent}%` }}
                            className="bg-primary/85 h-full"
                          />
                          <div
                            style={{ width: `${completionPercent}%` }}
                            className="bg-tertiary h-full"
                          />
                        </div>
                        <div className="flex items-center justify-between text-[11px] text-on-surface-variant mt-1.5">
                          <span className="flex items-center gap-1">
                            <span className="size-2 rounded-full bg-primary/85" />
                            Prompt: {formatNumber(promptTokens)} ({Math.round(promptPercent)}%)
                          </span>
                          <span className="flex items-center gap-1">
                            <span className="size-2 rounded-full bg-tertiary" />
                            Completion: {formatNumber(completionTokens)} ({Math.round(completionPercent)}%)
                          </span>
                        </div>
                      </div>

                      {/* Content Columns */}
                      <div className="grid gap-6 md:grid-cols-3">
                        <div>
                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Usage Metrics</h4>
                          <ul className="mt-3.5 space-y-2 text-[13px]">
                            <li className="flex items-center justify-between border-b border-outline-variant/30 pb-1.5">
                              <span className="text-on-surface-variant">Input / Prompt Tokens:</span>
                              <span className="font-semibold text-on-surface">{formatNumber(promptTokens)}</span>
                            </li>
                            <li className="flex items-center justify-between border-b border-outline-variant/30 pb-1.5">
                              <span className="text-on-surface-variant">Output / Completion Tokens:</span>
                              <span className="font-semibold text-on-surface">{formatNumber(completionTokens)}</span>
                            </li>
                            <li className="flex items-center justify-between font-bold">
                              <span className="text-on-surface">Total Session Tokens:</span>
                              <span className="text-primary">{formatNumber(totalTokens)}</span>
                            </li>
                          </ul>
                        </div>

                        <div>
                          <h4 className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Session History</h4>
                          <ul className="mt-3.5 space-y-2 text-[13px]">
                            <li className="flex items-center justify-between border-b border-outline-variant/30 pb-1.5">
                              <span className="text-on-surface-variant">Session ID:</span>
                              <span className="font-mono text-on-surface text-[12px]">{session.id}</span>
                            </li>
                            <li className="flex items-center justify-between border-b border-outline-variant/30 pb-1.5">
                              <span className="text-on-surface-variant">Started At:</span>
                              <span className="text-on-surface">{formatDate(session.created_at)}</span>
                            </li>
                            <li className="flex items-center justify-between">
                              <span className="text-on-surface-variant">Last Active:</span>
                              <span className="text-on-surface">{formatDate(session.updated_at)}</span>
                            </li>
                          </ul>
                        </div>

                        <div className="flex flex-col justify-between">
                          <div>
                            <h4 className="text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">Quick Actions</h4>
                            <p className="mt-2 text-on-surface-variant text-[12px] leading-relaxed">
                              Open the terminal console of this session to execute further offensive checks, view live tools, or download breach reports.
                            </p>
                          </div>
                          <div className="mt-4 flex gap-2">
                            <Link
                              href={`/dashboard/scan?chat_id=${encodeURIComponent(session.id)}`}
                              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3.5 text-[12px] font-bold text-on-primary hover:opacity-90"
                            >
                              <MaterialSymbol name="terminal" className="text-base text-on-primary" filled />
                              Open Terminal
                            </Link>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>

        {/* Footer info bar */}
        <div className="flex flex-col gap-3 border-t border-outline-variant px-5 py-4 text-[13px] text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
          <span>
            Aggregating {filteredSessions.length} of {sessions.length} chat threads
          </span>
          <span className="text-[12px] text-on-surface-variant italic">
            Usage totals update dynamically as LLM answers stream.
          </span>
        </div>
      </div>
    </div>
  );
}
