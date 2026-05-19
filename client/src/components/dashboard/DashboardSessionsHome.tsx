"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import {
  downloadAgentChatAttachment,
  generateAgentChatSessionReport,
  listAgentChatSessionIntelligence,
  type AgentChatAttachment,
  type AgentChatFindingSeverity,
  type AgentChatSessionIntelligence,
  type AgentChatSessionStatus,
} from "@/lib/agentChat";

const STATUS_LABELS: Record<AgentChatSessionStatus, string> = {
  IN_PROGRESS: "IN PROGRESS",
  COMPLETED: "COMPLETE",
  FAILED: "FAILED",
};

const SEVERITY_ORDER: AgentChatFindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m`;
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function statusClass(status: AgentChatSessionStatus): string {
  if (status === "COMPLETED") return "bg-emerald-50 text-emerald-800 ring-1 ring-emerald-200";
  if (status === "FAILED") return "bg-red-50 text-red-800 ring-1 ring-red-100";
  return "bg-primary-container text-on-primary-container ring-1 ring-primary/20";
}

function severityChips(row: AgentChatSessionIntelligence): string[] {
  return SEVERITY_ORDER.flatMap((sev) => {
    const key = sev.toLowerCase() as keyof AgentChatSessionIntelligence["findings_count"];
    const n = Number(row.findings_count[key] ?? 0);
    if (n <= 0) return [];
    const label = sev === "CRITICAL" ? "CRIT" : sev.slice(0, 3);
    return [`${n} ${label}`];
  });
}

function reportAvailable(row: AgentChatSessionIntelligence): boolean {
  return Boolean(row.report_metadata?.available || row.findings.length > 0 || row.summary);
}

function latestReportAttachment(row: AgentChatSessionIntelligence): AgentChatAttachment | null {
  const latest = row.report_metadata?.latest_attachment;
  if (latest && typeof latest === "object") {
    const a = latest as Record<string, unknown>;
    if (typeof a.id === "string" && typeof a.filename === "string") {
      return {
        id: a.id,
        filename: a.filename,
        content_type: typeof a.content_type === "string" ? a.content_type : "application/pdf",
      };
    }
  }
  const attachments = row.report_metadata?.attachments;
  if (!Array.isArray(attachments)) return null;
  for (let i = attachments.length - 1; i >= 0; i--) {
    const raw = attachments[i];
    if (!raw || typeof raw !== "object") continue;
    const a = raw as Record<string, unknown>;
    if (typeof a.id === "string" && typeof a.filename === "string") {
      return {
        id: a.id,
        filename: a.filename,
        content_type: typeof a.content_type === "string" ? a.content_type : "application/pdf",
      };
    }
  }
  return null;
}

function sortRows(
  rows: AgentChatSessionIntelligence[],
  sortMode: "newest" | "oldest",
): AgentChatSessionIntelligence[] {
  return [...rows].sort((a, b) => {
    const da = new Date(a.started_at).getTime() || 0;
    const db = new Date(b.started_at).getTime() || 0;
    return sortMode === "newest" ? db - da : da - db;
  });
}

export function DashboardSessionsHome() {
  const [rows, setRows] = useState<AgentChatSessionIntelligence[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [showFilters, setShowFilters] = useState(false);
  const [statusFilter, setStatusFilter] = useState<AgentChatSessionStatus | "ALL">("ALL");
  const [severityFilter, setSeverityFilter] = useState<AgentChatFindingSeverity | "ALL">("ALL");
  const [sortMode, setSortMode] = useState<"newest" | "oldest">("newest");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reportBusyId, setReportBusyId] = useState<string | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);

  async function load(silent = false) {
    if (!silent) setLoading(true);
    try {
      const data = await listAgentChatSessionIntelligence();
      setRows(data);
      setError(null);
      setSelectedId((current) => (current && data.some((row) => row.session_id === current) ? current : null));
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

  async function downloadReport(sessionId: string, attachment: AgentChatAttachment) {
    const { blob, filename } = await downloadAgentChatAttachment(sessionId, attachment.id);
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename || attachment.filename || "penetration-report.pdf";
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
  }

  async function generateReport(row: AgentChatSessionIntelligence, { downloadAfter = false } = {}) {
    setReportBusyId(row.session_id);
    setReportError(null);
    try {
      const result = await generateAgentChatSessionReport(row.session_id);
      await load(true);
      if (downloadAfter && result.attachment) {
        await downloadReport(row.session_id, result.attachment);
      }
    } catch (e) {
      setReportError(e instanceof Error ? e.message : String(e));
    } finally {
      setReportBusyId(null);
    }
  }

  async function handleReportAction(row: AgentChatSessionIntelligence) {
    const attachment = latestReportAttachment(row);
    setReportError(null);
    if (attachment) {
      try {
        await downloadReport(row.session_id, attachment);
      } catch (e) {
        setReportError(e instanceof Error ? e.message : String(e));
      }
      return;
    }
    await generateReport(row);
  }

  const metrics = useMemo(() => {
    const totalSessions = rows.length;
    const totalFindings = rows.reduce((sum, row) => sum + Number(row.findings_count.total ?? 0), 0);
    const critical = rows.reduce((sum, row) => sum + Number(row.findings_count.critical ?? 0), 0);
    const withSeconds = rows.filter((row) => Number(row.average_time_to_breach_seconds ?? 0) > 0);
    const avgSeconds =
      withSeconds.length > 0
        ? withSeconds.reduce((sum, row) => sum + Number(row.average_time_to_breach_seconds ?? 0), 0) / withSeconds.length
        : 0;
    return [
      {
        label: "Total scans",
        value: String(totalSessions),
        sub: totalSessions === 1 ? "1 intelligence session" : `${totalSessions} intelligence sessions`,
        trend: "up" as const,
        icon: "schedule",
        iconWrap: "bg-primary-container text-primary",
      },
      {
        label: "Vulnerabilities found",
        value: String(totalFindings),
        sub: critical > 0 ? `${critical} critical active` : "Evidence-backed findings",
        trend: null,
        icon: "verified_user",
        iconWrap: "bg-primary-container text-tertiary",
      },
      {
        label: "Avg. time to breach",
        value: formatDuration(avgSeconds),
        sub: "Unique active tool time",
        trend: null,
        icon: "speed",
        iconWrap: "bg-primary-container text-primary",
      },
    ];
  }, [rows]);

  const filteredRows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = rows.filter((row) => {
      if (statusFilter !== "ALL" && row.status !== statusFilter) return false;
      if (severityFilter !== "ALL") {
        const key = severityFilter.toLowerCase() as keyof AgentChatSessionIntelligence["findings_count"];
        if (Number(row.findings_count[key] ?? 0) <= 0) return false;
      }
      if (!q) return true;
      const haystack = [
        row.title,
        row.summary,
        sxId(row.session_id),
        row.session_id,
        ...row.targets,
        ...row.tools_used,
        ...row.findings.map((f) => `${f.name} ${f.affected_target} ${f.source_tool}`),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
    return sortRows(filtered, sortMode);
  }, [query, rows, severityFilter, sortMode, statusFilter]);

  const selected = selectedId ? rows.find((row) => row.session_id === selectedId) ?? null : null;

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
        {metrics.map((m) => (
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
              <span className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${m.iconWrap}`}>
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
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="Search by target or session ID…"
              className="h-11 w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-2.5 pr-3 pl-11 text-[15px] text-on-surface outline-none transition-[border-color,box-shadow] placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary"
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setShowFilters((v) => !v)}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-outline-variant px-4 text-[13px] font-semibold text-on-surface hover:bg-surface-container-high"
            >
              <MaterialSymbol name="filter_list" className="text-lg text-on-surface-variant" /> Filter
            </button>
            <button
              type="button"
              onClick={() => setSortMode((v) => (v === "newest" ? "oldest" : "newest"))}
              className="inline-flex h-10 items-center gap-2 rounded-xl border border-outline-variant px-4 text-[13px] font-semibold text-on-surface hover:bg-surface-container-high"
            >
              Sort: {sortMode === "newest" ? "Newest" : "Oldest"}
              <MaterialSymbol name="expand_more" className="text-lg" />
            </button>
          </div>
        </div>

        {showFilters ? (
          <div className="flex flex-wrap gap-2 border-b border-outline-variant px-5 py-3 text-[12px]">
            {(["ALL", "IN_PROGRESS", "COMPLETED", "FAILED"] as const).map((status) => (
              <button
                key={status}
                type="button"
                onClick={() => setStatusFilter(status)}
                className={`rounded-full px-3 py-1 font-bold ${
                  statusFilter === status ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                {status === "ALL" ? "All statuses" : STATUS_LABELS[status]}
              </button>
            ))}
            {(["ALL", ...SEVERITY_ORDER] as const).map((sev) => (
              <button
                key={sev}
                type="button"
                onClick={() => setSeverityFilter(sev)}
                className={`rounded-full px-3 py-1 font-bold ${
                  severityFilter === sev ? "bg-primary text-on-primary" : "bg-surface-container-high text-on-surface-variant"
                }`}
              >
                {sev === "ALL" ? "All severities" : sev}
              </button>
            ))}
          </div>
        ) : null}

        {error ? (
          <div className="border-b border-outline-variant px-5 py-3 text-[13px] font-semibold text-red-700">
            {error}
          </div>
        ) : null}
        {reportError ? (
          <div className="border-b border-outline-variant px-5 py-3 text-[13px] font-semibold text-red-700">
            {reportError}
          </div>
        ) : null}

        <div className="overflow-x-auto">
          <table className="min-w-[760px] w-full border-collapse text-left text-[14px]">
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
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center text-on-surface-variant">
                    Loading session intelligence…
                  </td>
                </tr>
              ) : filteredRows.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-12 text-center">
                    <div className="mx-auto max-w-md">
                      <MaterialSymbol name="travel_explore" className="text-4xl text-primary" />
                      <p className="mt-3 text-[15px] font-bold text-on-surface">No completed tool sessions yet</p>
                      <p className="mt-1 text-[13px] text-on-surface-variant">
                        Sessions appear here after a chat thread successfully executes at least one tool.
                      </p>
                      <Link
                        href="/dashboard/scan?new=1"
                        className="mt-4 inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-[13px] font-bold text-on-primary hover:opacity-90"
                      >
                        <MaterialSymbol name="add" className="text-base text-on-primary" filled />
                        Start scan
                      </Link>
                    </div>
                  </td>
                </tr>
              ) : (
                filteredRows.map((r) => {
                  const chips = severityChips(r);
                  const reportAttachment = latestReportAttachment(r);
                  const reportBusy = reportBusyId === r.session_id;
                  return (
                    <tr key={r.session_id} className="border-b border-outline-variant/80 hover:bg-primary-container/[0.12]">
                      <td className="px-5 py-4">
                        <p className="font-semibold text-on-surface">{r.title}</p>
                        <p className="text-[13px] text-on-surface-variant">
                          {sxId(r.session_id)}
                          {r.targets[0] ? ` · ${r.targets[0]}` : ""}
                        </p>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`inline-flex rounded-full px-3 py-1 text-[11px] font-bold tracking-wide ${statusClass(r.status)}`}>
                          {STATUS_LABELS[r.status]}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-on-surface-variant">{formatDate(r.started_at)}</td>
                      <td className="px-5 py-4">
                        <div className="flex flex-wrap gap-1.5">
                          {chips.length === 0 ? (
                            <span className="text-on-surface-variant">—</span>
                          ) : (
                            chips.map((f) => (
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
                          <button
                            type="button"
                            onClick={() => setSelectedId((current) => (current === r.session_id ? null : r.session_id))}
                            className="rounded-lg p-2 hover:bg-primary-container hover:text-primary"
                            title={reportAvailable(r) ? "Description and report" : "Description"}
                          >
                            <MaterialSymbol name="description" filled />
                          </button>
                          <Link
                            href={`/dashboard/scan?chat_id=${encodeURIComponent(r.session_id)}`}
                            className="rounded-lg p-2 hover:bg-primary-container hover:text-primary"
                            title="Terminal"
                          >
                            <MaterialSymbol name="terminal" filled />
                          </Link>
                          <button
                            type="button"
                            disabled={reportBusy}
                            onClick={() => handleReportAction(r)}
                            className="rounded-lg p-2 hover:bg-primary-container hover:text-primary disabled:cursor-not-allowed disabled:opacity-40"
                            title={
                              reportBusy
                                ? "Generating PDF report…"
                                : reportAttachment
                                  ? "Download PDF report"
                                  : "Generate PDF report"
                            }
                          >
                            <MaterialSymbol
                              name={reportBusy ? "progress_activity" : "picture_as_pdf"}
                              className={reportBusy ? "animate-spin" : ""}
                              filled
                            />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex flex-col gap-3 border-t border-outline-variant px-5 py-4 text-[13px] text-on-surface-variant sm:flex-row sm:items-center sm:justify-between">
          <span>
            Showing {filteredRows.length === 0 ? 0 : 1} to {filteredRows.length} of {filteredRows.length} sessions
          </span>
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

      {selected ? (
        <section className="mt-6 rounded-2xl border border-outline-variant bg-surface px-6 py-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-primary">Session intelligence</p>
              <h2 className="mt-2 text-xl font-bold text-on-surface">{selected.title}</h2>
              <p className="mt-2 max-w-3xl text-[14px] leading-relaxed text-on-surface-variant">{selected.summary}</p>
            </div>
            <button
              type="button"
              onClick={() => setSelectedId(null)}
              className="self-start rounded-lg p-2 text-on-surface-variant hover:bg-surface-container-high"
              title="Close details"
            >
              <MaterialSymbol name="close" />
            </button>
          </div>

          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <div>
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface-variant">Tools</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {selected.tools_used.map((tool) => (
                  <span key={tool} className="rounded-lg bg-surface-container-high px-2 py-1 text-[12px] font-semibold">
                    {tool}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface-variant">Targets</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {(selected.targets.length ? selected.targets : ["unknown"]).map((target) => (
                  <span key={target} className="rounded-lg bg-surface-container-high px-2 py-1 text-[12px] font-semibold">
                    {target}
                  </span>
                ))}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface-variant">Metadata</h3>
              <p className="mt-2 text-[13px] text-on-surface-variant">
                Breach time {selected.average_time_to_breach} · Updated {formatDate(selected.updated_at)}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={reportBusyId === selected.session_id}
                  onClick={() => handleReportAction(selected)}
                  className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-[12px] font-bold text-on-primary hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <MaterialSymbol
                    name={reportBusyId === selected.session_id ? "progress_activity" : "picture_as_pdf"}
                    className={`text-base text-on-primary ${reportBusyId === selected.session_id ? "animate-spin" : ""}`}
                    filled
                  />
                  {reportBusyId === selected.session_id
                    ? "Generating PDF…"
                    : latestReportAttachment(selected)
                      ? "Download PDF"
                      : "Generate PDF"}
                </button>
                {latestReportAttachment(selected) ? (
                  <button
                    type="button"
                    disabled={reportBusyId === selected.session_id}
                    onClick={() => generateReport(selected)}
                    className="inline-flex items-center gap-2 rounded-lg border border-outline-variant px-3 py-2 text-[12px] font-bold text-on-surface hover:bg-surface-container-high disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    <MaterialSymbol name="picture_as_pdf" className="text-base" filled />
                    Regenerate PDF
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="mt-6 grid gap-5 lg:grid-cols-2">
            <div>
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface-variant">Findings summary</h3>
              <div className="mt-3 space-y-3">
                {selected.findings.length === 0 ? (
                  <p className="text-[13px] text-on-surface-variant">No evidence-backed vulnerabilities were extracted.</p>
                ) : (
                  selected.findings.slice(0, 6).map((finding) => (
                    <div key={finding.id} className="rounded-xl border border-outline-variant px-4 py-3">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-lg bg-surface-container-high px-2 py-0.5 text-[11px] font-bold">
                          {finding.severity}
                        </span>
                        <p className="text-[14px] font-bold text-on-surface">{finding.name}</p>
                      </div>
                      <p className="mt-2 text-[13px] text-on-surface-variant">{finding.details}</p>
                      <p className="mt-2 line-clamp-2 text-[12px] text-on-surface-variant">Evidence: {finding.evidence}</p>
                    </div>
                  ))
                )}
              </div>
            </div>
            <div>
              <h3 className="text-[13px] font-bold uppercase tracking-wider text-on-surface-variant">Timeline</h3>
              <div className="mt-3 space-y-3">
                {selected.timeline.slice(-8).map((event, idx) => (
                  <div key={`${event.timestamp}-${event.type}-${idx}`} className="border-l-2 border-primary/30 pl-3">
                    <p className="text-[12px] font-semibold text-on-surface-variant">{formatDate(event.timestamp)}</p>
                    <p className="mt-1 text-[14px] font-bold text-on-surface">{event.title}</p>
                    {event.details ? <p className="mt-1 text-[12px] text-on-surface-variant">{event.details}</p> : null}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      ) : null}
    </div>
  );
}
