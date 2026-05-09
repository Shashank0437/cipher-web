"use client";

import Link from "next/link";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

const METRICS = [
  {
    label: "Total scans",
    value: "4",
    sub: "+12% from last month",
    trend: "up" as const,
    icon: "schedule",
    iconWrap: "bg-primary-container text-primary",
  },
  {
    label: "Vulnerabilities found",
    value: "32",
    sub: "1 critical active",
    trend: null,
    icon: "verified_user",
    iconWrap: "bg-primary-container text-tertiary",
  },
  {
    label: "Avg. time to breach",
    value: "14m 22s",
    sub: "Optimized by AI",
    trend: null,
    icon: "speed",
    iconWrap: "bg-primary-container text-primary",
  },
] as const;

const ROWS = [
  {
    title: "CVE sweep — web tier",
    sid: "#SX-30312",
    status: "COMPLETE" as const,
    started: "18 Apr 2026, 16:31",
    findings: ["1 CRIT", "12 INF"],
  },
  {
    title: "API fuzz — staging",
    sid: "#SX-30398",
    status: "FAILED" as const,
    started: "17 Apr 2026, 09:42",
    findings: [],
  },
  {
    title: "External Surface Scan — Acme perimeter",
    sid: "#SX-29901",
    status: "COMPLETE" as const,
    started: "12 Apr 2026, 11:05",
    findings: ["2 HIGH", "4 MED"],
  },
  {
    title: "Auth hardening replay — SOC tabletop",
    sid: "#SX-29844",
    status: "COMPLETE" as const,
    started: "08 Apr 2026, 19:52",
    findings: ["3 INF"],
  },
];

export function DashboardSessionsHome() {
  return (
    <div className="mx-auto max-w-[1200px] px-6 py-10 pb-20">
      <header className="mb-10">
        <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Sessions</p>
        <h1 className="mt-2 text-[1.85rem] font-bold tracking-tight text-on-surface">Session History</h1>
        <p className="mt-2 max-w-2xl text-[15px] leading-relaxed text-on-surface-variant">
          Manage and review offensive security operations and automated breach reports.
        </p>
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        {METRICS.map((m) => (
          <div
            key={m.label}
            className="rounded-2xl border border-outline-variant bg-surface px-6 py-5 shadow-sm transition-shadow hover:shadow-md"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-[13px] font-semibold text-on-surface-variant">{m.label}</p>
                <p className="mt-2 text-3xl font-bold tracking-tight text-on-surface">{m.value}</p>
                <p className="mt-2 flex items-center gap-1.5 text-[13px] text-on-surface-variant">
                  {m.trend === "up" ? (
                    <MaterialSymbol name="trending_up" className="text-lg text-emerald-600" filled />
                  ) : null}
                  {m.sub}
                </p>
              </div>
              <span
                className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${m.iconWrap}`}
              >
                <MaterialSymbol name={m.icon} className="text-[26px]" filled />
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-10 rounded-2xl border border-outline-variant bg-surface shadow-sm">
        <div className="flex flex-col gap-4 border-b border-outline-variant px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <label className="relative block max-w-xl flex-1">
            <MaterialSymbol
              name="search"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
            />
            <input
              type="search"
              placeholder="Search by target or session ID…"
              className="h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-2.5 pr-3 pl-11 text-[15px] text-on-surface outline-none transition-[border-color,box-shadow] placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary"
              readOnly
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-outline-variant px-4 text-[13px] font-semibold text-on-surface hover:bg-surface-container-high"
            >
              <MaterialSymbol name="filter_list" className="text-lg text-on-surface-variant" /> Filter
            </button>
            <button
              type="button"
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-outline-variant px-4 text-[13px] font-semibold text-on-surface hover:bg-surface-container-high"
            >
              Sort: Newest
              <MaterialSymbol name="expand_more" className="text-lg" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[720px] w-full border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-outline-variant text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
                <th className="px-5 py-3.5">Target</th>
                <th className="px-5 py-3.5">Status</th>
                <th className="px-5 py-3.5">Date started</th>
                <th className="px-5 py-3.5">Findings</th>
                <th className="px-5 py-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.sid} className="border-b border-outline-variant/80 hover:bg-primary-container/[0.12]">
                  <td className="px-5 py-4">
                    <p className="font-semibold text-on-surface">{r.title}</p>
                    <p className="text-[13px] text-on-surface-variant">{r.sid}</p>
                  </td>
                  <td className="px-5 py-4">
                    <span
                      className={`inline-flex rounded-full px-3 py-1 text-[11px] font-bold tracking-wide ${
                        r.status === "COMPLETE"
                          ? "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200"
                          : "bg-red-50 text-red-800 ring-1 ring-red-100"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="px-5 py-4 text-on-surface-variant">{r.started}</td>
                  <td className="px-5 py-4">
                    <div className="flex flex-wrap gap-1.5">
                      {r.findings.length === 0 ? (
                        <span className="text-on-surface-variant">—</span>
                      ) : (
                        r.findings.map((f) => (
                          <span
                            key={f}
                            className="rounded-lg bg-surface-container-high px-2 py-0.5 text-[11px] font-semibold uppercase text-on-surface-variant"
                          >
                            {f}
                          </span>
                        ))
                      )}
                    </div>
                  </td>
                  <td className="px-5 py-4 text-right">
                    <div className="inline-flex gap-2 text-on-surface-variant">
                      <button type="button" className="rounded-lg p-2 hover:bg-primary-container hover:text-primary" title="Description">
                        <MaterialSymbol name="description" filled />
                      </button>
                      <button type="button" className="rounded-lg p-2 hover:bg-primary-container hover:text-primary" title="Terminal">
                        <MaterialSymbol name="terminal" filled />
                      </button>
                      <button type="button" className="rounded-lg p-2 hover:bg-primary-container hover:text-primary" title="Replay">
                        <MaterialSymbol name="replay" filled />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-outline-variant px-5 py-4 text-[13px] text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
          <span>Showing 1 to 4 of 4 sessions</span>
          <div className="flex items-center gap-2">
            <button type="button" className="rounded-lg px-3 py-1.5 font-semibold hover:bg-surface-container-high">
              ‹
            </button>
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-[13px] font-bold text-on-primary">
              1
            </span>
            <button type="button" className="rounded-lg px-3 py-1.5 font-semibold hover:bg-surface-container-high">
              ›
            </button>
          </div>
        </div>
      </div>

      <div className="mt-12 flex flex-wrap items-start justify-between gap-4 rounded-2xl border border-dashed border-primary/30 bg-gradient-to-br from-primary-container/40 to-transparent px-6 py-6">
        <div>
          <h2 className="text-[17px] font-bold text-on-surface">Executive Report Preview</h2>
          <p className="mt-2 max-w-lg text-[14px] text-on-surface-variant">
            High-level rollup of exposure, SLA posture, and remediation velocity — wiring to live analytics arrives as the mesh matures.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-x-6 gap-y-2">
          <Link href="/dashboard/analytics" className="text-[14px] font-bold text-primary hover:underline">
            Open analytics
          </Link>
          <Link href="/dashboard/tools" className="text-[14px] font-bold text-primary hover:underline">
            Open tooling
          </Link>
        </div>
      </div>
    </div>
  );
}
