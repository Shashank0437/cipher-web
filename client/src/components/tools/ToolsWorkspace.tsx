"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { ToolHistoryModal } from "@/components/tools/ToolHistoryModal";
import { ToolInfoModal } from "@/components/tools/ToolInfoModal";
import { ToolRunModal } from "@/components/tools/ToolRunModal";
import { ApiError, api } from "@/lib/api";
import type { WorkspaceToolCard, WorkspaceToolsResponse, ToolAvailabilityFilter } from "@/components/tools/types";
import { getToolCardTeaser } from "@/components/tools/toolCardTeaser";
import { formatToolCategoryLabel } from "@/components/tools/toolRunFormUtils";
import { ToolAvailabilityDropdown } from "@/components/tools/ToolAvailabilityDropdown";

const iconActionClass =
  "inline-flex size-10 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-primary-container hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface";
const iconActionDangerClass =
  "inline-flex size-10 items-center justify-center rounded-xl text-on-surface-variant transition hover:bg-error-container hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface";

function formatUptime(seconds: number | null): string {
  if (seconds === null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.slice(0, 3).join(" ");
}

function HealthBars({ value }: { value: number }) {
  const n = Math.max(1, Math.min(5, Math.round(value)));
  return (
    <div className="flex gap-1" aria-label={`Health ${n} of 5`}>
      {Array.from({ length: 5 }, (_, i) => (
        <span
          key={i}
          className={`h-1 w-6 rounded-full ${
            i < n ? (n <= 2 ? "bg-error" : "bg-primary") : "bg-outline-variant opacity-35"
          }`}
        />
      ))}
    </div>
  );
}

export type ToolsWorkspaceIntro = "full" | "dashboard";

export function ToolsWorkspace({ intro = "full" }: { intro?: ToolsWorkspaceIntro }) {
  const [data, setData] = useState<WorkspaceToolsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("All");
  const [search, setSearch] = useState("");
  const [availabilityFilter, setAvailabilityFilter] = useState<ToolAvailabilityFilter>("allowed_all");
  const [refreshing, setRefreshing] = useState(false);
  const [selectedTool, setSelectedTool] = useState<WorkspaceToolCard | null>(null);
  const [infoTool, setInfoTool] = useState<WorkspaceToolCard | null>(null);
  const [historyToolName, setHistoryToolName] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const j = await api<WorkspaceToolsResponse>("/workspace/tools");
      setData(j);
    } catch (e) {
      if (e instanceof ApiError) {
        const hint401 = e.status === 401 ? " Sign in as a tenant administrator." : "";
        setError(`${e.message}${e.status === 503 ? " (agent unreachable)" : ""}${hint401}`);
      } else setError(e instanceof Error ? e.message : "Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refreshAvailability = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      await api<{ success?: boolean; error?: string }>("/workspace/tools/availability/refresh", {
        method: "POST",
      });
      await load();
    } catch (e) {
      if (e instanceof ApiError)
        setError(`${e.message}${e.status === 503 ? " (agent unreachable)" : ""}${e.status === 401 ? " Sign in." : ""}`);
      else setError(e instanceof Error ? e.message : "Refresh failed");
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  const disabledTools = useMemo(() => data?.disabled_tools ?? [], [data]);

  const patchToolPolicy = useCallback(
    async (toolName: string, enabled: boolean) => {
      setError(null);
      try {
        await api("/tenant/tools/policy", {
          method: "PATCH",
          json: { tool_name: toolName, enabled },
        });
        await load();
      } catch (e) {
        if (e instanceof ApiError) setError(e.message);
        else setError(e instanceof Error ? e.message : "Could not update policy");
      }
    },
    [load],
  );

  const restrictedCategories = useMemo(
    () => [...new Set(disabledTools.map((t) => t.category))].sort(),
    [disabledTools],
  );

  const categoryNavItems = useMemo(() => {
    if (!data) return ["All"] as const;
    if (availabilityFilter === "org_restricted") {
      return ["All", ...restrictedCategories] as const;
    }
    return ["All", ...(data.categories ?? []).slice().sort()] as const;
  }, [availabilityFilter, data, restrictedCategories]);

  useEffect(() => {
    const valid = new Set<string>(categoryNavItems);
    if (filter !== "All" && !valid.has(filter)) setFilter("All");
  }, [categoryNavItems, filter]);

  const allowedInstalledCount = useMemo(() => data?.tools.filter((t) => t.active).length ?? 0, [data]);

  const allowedMissingCount = useMemo(() => data?.tools.filter((t) => !t.active).length ?? 0, [data]);

  const allowedTotalCount = data?.tools.length ?? 0;

  const restrictedCount = disabledTools.length;

  const availabilityOptions = useMemo(
    () =>
      [
        { value: "allowed_all" as const, label: `Enabled (${allowedTotalCount})` },
        { value: "allowed_installed" as const, label: `Installed on host (${allowedInstalledCount})` },
        { value: "allowed_not_installed" as const, label: `Not installed (${allowedMissingCount})` },
        { value: "org_restricted" as const, label: `Disabled by organization (${restrictedCount})` },
      ] as const,
    [allowedTotalCount, allowedInstalledCount, allowedMissingCount, restrictedCount],
  );

  const filteredTools = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();

    let base: WorkspaceToolCard[];
    if (availabilityFilter === "org_restricted") {
      base = filter === "All" ? [...disabledTools] : disabledTools.filter((t) => t.category === filter);
    } else {
      base = filter === "All" ? [...data.tools] : data.tools.filter((t) => t.category === filter);
      if (availabilityFilter === "allowed_installed") base = base.filter((t) => t.active);
      else if (availabilityFilter === "allowed_not_installed") base = base.filter((t) => !t.active);
    }

    if (q) {
      base = base.filter((t) => {
        const hay = `${t.name} ${t.description} ${t.long_description ?? ""} ${t.usage ?? ""} ${t.safety ?? ""} ${t.category} ${t.documentation_url ?? ""}`
          .toLowerCase()
          .replace(/\s+/g, " ");
        return hay.includes(q);
      });
    }
    return base;
  }, [availabilityFilter, data, disabledTools, filter, search]);

  /** Rows matching category + availability, before search (for “Showing X of Y”). */
  const gridTotalBasis = useMemo(() => {
    if (!data) return 0;
    const slice = (): WorkspaceToolCard[] => {
      if (availabilityFilter === "org_restricted") {
        return filter === "All" ? [...disabledTools] : disabledTools.filter((t) => t.category === filter);
      }
      const allowed =
        filter === "All" ? [...data.tools] : data.tools.filter((t) => t.category === filter);
      if (availabilityFilter === "allowed_installed") return allowed.filter((t) => t.active);
      if (availabilityFilter === "allowed_not_installed") return allowed.filter((t) => !t.active);
      return allowed;
    };
    return slice().length;
  }, [availabilityFilter, data, disabledTools, filter]);

  const filterEmptyHint = useMemo(() => {
    if (availabilityFilter === "org_restricted") {
      if (restrictedCount === 0) return "Your organization has not restricted any catalog tools.";
      return "No restricted tools match this category or search.";
    }
    if (availabilityFilter === "allowed_installed")
      return "No matching tools reported as installed on the host.";
    if (availabilityFilter === "allowed_not_installed")
      return "No matching tools reported as missing on the host.";
    return "No tools match this category or search.";
  }, [availabilityFilter, restrictedCount]);

  const kaliCoveragePct = useMemo(() => {
    if (!data?.overview.kali_tools) return null;
    const { available, total } = data.overview.kali_tools;
    if (total <= 0) return null;
    return Math.round((available / total) * 100);
  }, [data]);

  const categoryScrollRef = useRef<HTMLDivElement>(null);
  const [categoryScrollFade, setCategoryScrollFade] = useState({ left: false, right: false });

  const updateCategoryScrollFade = useCallback(() => {
    const el = categoryScrollRef.current;
    if (!el) {
      setCategoryScrollFade({ left: false, right: false });
      return;
    }
    const { scrollLeft, scrollWidth, clientWidth } = el;
    const maxScroll = scrollWidth - clientWidth;
    setCategoryScrollFade({
      left: scrollLeft > 4,
      right: maxScroll > 4 && scrollLeft < maxScroll - 4,
    });
  }, []);

  useLayoutEffect(() => {
    updateCategoryScrollFade();
  }, [updateCategoryScrollFade, categoryNavItems.length, loading, data]);

  useEffect(() => {
    const el = categoryScrollRef.current;
    if (!el) return;
    updateCategoryScrollFade();
    el.addEventListener("scroll", updateCategoryScrollFade, { passive: true });
    const ro = new ResizeObserver(() => updateCategoryScrollFade());
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", updateCategoryScrollFade);
      ro.disconnect();
    };
  }, [updateCategoryScrollFade, categoryNavItems.length]);

  const shell =
    intro === "dashboard"
      ? "w-full max-w-7xl mx-auto px-0 pb-16 pt-2"
      : "mx-auto max-w-7xl px-4 pb-16 pt-6 sm:px-6";

  const statsTop = intro === "dashboard" ? "mt-6" : "mt-8";
  const filtersTop = intro === "dashboard" ? "mt-6" : "mt-8";
  const gridTop = intro === "dashboard" ? "mt-6" : "mt-8";

  return (
    <div className={shell}>
      <ToolRunModal
        tool={selectedTool}
        onClose={() => setSelectedTool(null)}
        onOpenToolInfo={() => {
          if (selectedTool) setInfoTool(selectedTool);
        }}
      />
      <ToolInfoModal tool={infoTool} onClose={() => setInfoTool(null)} />
      <ToolHistoryModal toolName={historyToolName} onClose={() => setHistoryToolName(null)} />
      {intro === "full" ? (
        <>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">CipherStrike arsenal</p>
          <h1 className="mt-2 text-[2rem] font-bold tracking-tight text-on-surface">Tools workspace</h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-on-surface-variant">
            Orchestration probes are proxied through the CipherStrike API. The NyxStrike agent never exposes arbitrary
            callers on your port-forward boundary.
          </p>
        </>
      ) : (
        <>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">Tools</p>
          <h1 className="mt-2 text-[1.75rem] font-bold tracking-tight text-on-surface">Tooling</h1>
          <p className="mt-3 max-w-2xl text-[15px] leading-relaxed text-on-surface-variant">
            Launcher, pinning, and live availability for sanctioned binaries stay on this page—probe status and the full
            catalog are below.
          </p>
        </>
      )}

      {error ? (
        <div className="mt-8 rounded-2xl border border-error-container bg-error-container/15 px-4 py-4 text-on-surface">
          <p className="font-semibold text-error">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 rounded-lg bg-primary px-4 py-2 text-[14px] font-semibold text-on-primary hover:bg-primary-dim"
          >
            Retry
          </button>
        </div>
      ) : null}

      {/* Stat cards */}
      <div className={`${statsTop} grid gap-4 sm:grid-cols-2 lg:grid-cols-3`}>
        <article className="rounded-2xl border border-outline-variant bg-surface px-6 py-5 shadow-sm transition-shadow hover:shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-on-surface-variant">Server status</p>
              <p className="mt-3 text-xl font-bold text-on-surface">
                {loading ? "…" : data?.overview.server.agent_reachable ? "Operational" : "Degraded"}
              </p>
            </div>
            <span
              className={`flex size-12 shrink-0 items-center justify-center rounded-2xl ${
                loading
                  ? "bg-primary-container text-primary"
                  : data?.overview.server.agent_reachable
                    ? "bg-primary-container text-primary"
                    : "bg-surface-container-high text-on-surface-variant"
              }`}
              aria-hidden
            >
              <MaterialSymbol
                name={
                  loading
                    ? "progress_activity"
                    : data?.overview.server.agent_reachable
                      ? "dns"
                      : "cloud_off"
                }
                className={`text-[26px] ${loading ? "animate-spin" : ""}`}
                filled={!loading}
              />
            </span>
          </div>
          <dl className="mt-4 space-y-1 text-[13px] text-on-surface-variant">
            <div className="flex justify-between gap-2">
              <dt>CipherStrike API</dt>
              <dd className="font-semibold text-on-surface">{data?.overview.server.cipherstrike_api ?? "—"}</dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Agent</dt>
              <dd className="truncate font-medium text-on-surface" title={data?.overview.server.agent_message ?? ""}>
                {data?.overview.server.agent_status ?? (loading ? "…" : "—")}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt>Uptime</dt>
              <dd>{formatUptime(data?.overview.server.agent_uptime_seconds ?? null)}</dd>
            </div>
            {data?.overview.server.agent_version ? (
              <div className="flex justify-between gap-2">
                <dt>Version</dt>
                <dd className="font-mono text-on-surface">{data.overview.server.agent_version}</dd>
              </div>
            ) : null}
          </dl>
        </article>

        <article className="rounded-2xl border border-outline-variant bg-surface px-6 py-5 shadow-sm transition-shadow hover:shadow-md">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-on-surface-variant">Kali tools</p>
              <p className="mt-3 text-xl font-bold text-on-surface">
                {loading
                  ? "…"
                  : `${data?.overview.kali_tools.available ?? 0} / ${data?.overview.kali_tools.total ?? 0}`}{" "}
                <span className="text-[14px] font-normal text-on-surface-variant">
                  installed
                  {!loading && kaliCoveragePct !== null ? ` (${kaliCoveragePct}% coverage)` : ""}
                </span>
              </p>
            </div>
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-container text-tertiary" aria-hidden>
              <MaterialSymbol name="radar" className="text-[26px]" filled />
            </span>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-on-surface-variant">
            Counts reflect tools <span className="font-medium text-on-surface">allowed for your organization</span>{" "}
            (restricted tools are listed below). Binary install status still comes from the agent probe on the host.
          </p>
        </article>

        <article className="rounded-2xl border border-outline-variant bg-surface px-6 py-5 shadow-sm transition-shadow hover:shadow-md sm:col-span-2 lg:col-span-1">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-on-surface-variant">Server tools</p>
              <p className="mt-3 text-xl font-bold text-on-surface">
                {loading
                  ? "…"
                  : `${data?.overview.server_tools.available ?? 0} / ${data?.overview.server_tools.total ?? 0}`}{" "}
                <span className="text-[14px] font-normal text-on-surface-variant">ready</span>
              </p>
            </div>
            <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary-container text-primary" aria-hidden>
              <MaterialSymbol name="hub" className="text-[26px]" filled />
            </span>
          </div>
          <p className="mt-4 text-[13px] leading-relaxed text-on-surface-variant">
            Embedded intelligence routers: agent catalog categories intelligence, ai assist, vulnerability intelligence.
          </p>
        </article>
      </div>

      {/* Categories + find tools (dashboard-style controls) */}
      <div className={`${filtersTop} rounded-2xl border border-outline-variant bg-surface shadow-sm`}>
        <div className="space-y-4 px-5 py-4">
          <div>
            <div className="flex items-end justify-between gap-3">
              <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-on-surface-variant">Categories</p>
              {categoryScrollFade.right || categoryScrollFade.left ? (
                <p className="hidden text-[11px] text-on-surface-variant sm:block">Scroll for more →</p>
              ) : null}
            </div>
            <div className="relative mt-2">
              {categoryScrollFade.left ? (
                <div
                  className="pointer-events-none absolute inset-y-1 left-0 z-[1] w-8 rounded-l-lg bg-gradient-to-r from-surface to-transparent"
                  aria-hidden
                />
              ) : null}
              {categoryScrollFade.right ? (
                <div
                  className="pointer-events-none absolute inset-y-1 right-0 z-[1] w-8 rounded-r-lg bg-gradient-to-l from-surface to-transparent"
                  aria-hidden
                />
              ) : null}
              <div
                ref={categoryScrollRef}
                className="terminal-scroll -mx-1 overflow-x-auto overflow-y-hidden px-1 [-ms-overflow-style:none] [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-outline-variant"
              >
                <nav aria-label="Tool categories" className="flex w-max flex-nowrap gap-2 pb-1">
                  {categoryNavItems.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setFilter(c)}
                      className={`inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-xl px-4 py-2 text-[13px] font-semibold transition ${
                        filter === c
                          ? "bg-primary text-on-primary shadow-sm ring-2 ring-primary/25"
                          : "bg-surface-container text-on-surface hover:bg-primary-container"
                      }`}
                    >
                      {c === "All" ? "All categories" : formatToolCategoryLabel(c)}
                    </button>
                  ))}
                </nav>
              </div>
            </div>
          </div>

          <div className="h-px bg-outline-variant" role="separator" aria-hidden />

          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-on-surface-variant">Find tools</p>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <label className="relative min-w-[min(100%,12rem)] flex-1 sm:min-w-[16rem]">
                <MaterialSymbol
                  name="search"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-on-surface-variant"
                />
                <input
                  type="search"
                  placeholder="Search tools…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-10 w-full rounded-xl border border-outline-variant bg-surface-container-lowest py-2.5 pr-10 pl-11 text-[14px] text-on-surface outline-none transition-[border-color,box-shadow] placeholder:text-on-surface-variant focus:border-primary focus:ring-1 focus:ring-primary no-search-cancel"
                  aria-label="Search tools"
                />
                {search.trim().length > 0 ? (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 inline-flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-on-surface-variant transition hover:bg-surface-container hover:text-primary"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                  >
                    <MaterialSymbol name="close" className="text-lg" />
                  </button>
                ) : null}
              </label>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
                <span className="sr-only" id="tool-availability-dropdown-label">
                  Tool availability filter
                </span>
                <ToolAvailabilityDropdown
                  labelledBy="tool-availability-dropdown-label"
                  value={availabilityFilter}
                  onChange={setAvailabilityFilter}
                  options={availabilityOptions}
                />
                <button
                  type="button"
                  disabled={loading || refreshing}
                  className="inline-flex h-10 items-center justify-center gap-2 rounded-xl border border-outline-variant bg-surface-container-lowest px-4 text-[13px] font-semibold text-on-surface transition hover:border-primary hover:text-primary disabled:opacity-50"
                  onClick={() => void refreshAvailability()}
                  title="Ask the agent to re-probe binaries on the host"
                >
                  <MaterialSymbol
                    name={refreshing ? "progress_activity" : "refresh"}
                    className={`text-[20px] ${refreshing ? "animate-spin" : ""}`}
                  />
                  Refresh
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {!loading && !error && data ? (
        <p className="mt-3 text-[13px] text-on-surface-variant">
          Showing{" "}
          <span className="font-semibold text-on-surface">{filteredTools.length}</span>
          {" of "}
          <span className="font-semibold text-on-surface">{gridTotalBasis}</span>
        </p>
      ) : null}

      {/* Grid */}
      {loading ? (
        <div className={`${gridTop} grid gap-4 sm:grid-cols-2 xl:grid-cols-3`}>
          {Array.from({ length: 6 }, (_, i) => (
            <div key={i} className="h-40 animate-pulse rounded-2xl bg-surface-container-high" />
          ))}
        </div>
      ) : (
        <ul className={`${gridTop} grid gap-4 sm:grid-cols-2 xl:grid-cols-3`}>
          {filteredTools.map((t) => {
            const teaser = getToolCardTeaser(t);
            const restrictedView = availabilityFilter === "org_restricted";
            return (
              <li
                key={`${restrictedView ? "r" : "a"}-${t.name}`}
                className="flex h-full flex-col rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-sm transition hover:shadow-md focus-within:ring-2 focus-within:ring-primary/35"
              >
                {restrictedView ? (
                  <div className="flex min-h-[7rem] flex-1 flex-col rounded-t-2xl px-5 py-4">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-[17px] font-bold leading-snug tracking-tight text-on-surface">{t.name}</h2>
                      <MaterialSymbol name="block" className="shrink-0 text-2xl text-on-surface-variant" />
                    </div>
                    <span className="mt-3 inline-flex w-fit rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-on-primary-container">
                      {formatToolCategoryLabel(t.category)}
                    </span>
                    <p className="mt-3 flex-1 text-[13px] leading-snug text-on-surface-variant line-clamp-2">{teaser || "—"}</p>
                    <p className="mt-3 text-[12px] font-medium text-error">Not available for runners—restore to allow use.</p>
                  </div>
                ) : (
                  <button
                    type="button"
                    aria-label={`Run ${t.name}`}
                    title={teaser || t.name}
                    onClick={() => setSelectedTool(t)}
                    className="flex min-h-[8rem] flex-1 flex-col rounded-t-2xl px-5 py-4 text-left outline-none transition hover:bg-surface-container/40 focus-visible:bg-surface-container/40"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="text-[17px] font-bold leading-snug tracking-tight text-on-surface">{t.name}</h2>
                      <MaterialSymbol
                        name={t.active ? "check_circle" : "cancel"}
                        className={`shrink-0 text-2xl ${t.active ? "text-tertiary" : "text-on-surface-variant"}`}
                        filled={t.active}
                      />
                    </div>
                    <span className="mt-3 inline-flex w-fit rounded-full bg-primary-container px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-on-primary-container">
                      {formatToolCategoryLabel(t.category)}
                    </span>
                    <p className="mt-3 flex-1 text-[13px] leading-snug text-on-surface-variant line-clamp-2">{teaser || "—"}</p>
                    <div className="mt-4">
                      <HealthBars value={t.health_bars} />
                    </div>
                  </button>
                )}
                <div className="flex shrink-0 items-center justify-end gap-1 border-t border-outline-variant px-2 py-2 sm:px-3">
                  {t.documentation_url?.trim() ? (
                    <a
                      href={t.documentation_url.trim()}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={iconActionClass}
                      aria-label={`Official documentation for ${t.name}`}
                      title="Official docs (opens in new tab)"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <MaterialSymbol name="open_in_new" className="text-[22px]" />
                    </a>
                  ) : null}
                  <button
                    type="button"
                    className={iconActionClass}
                    aria-label={`Full details for ${t.name}`}
                    title="Tool details and parameters"
                    onClick={(e) => {
                      e.stopPropagation();
                      setInfoTool(t);
                    }}
                  >
                    <MaterialSymbol name="info" className="text-[22px]" />
                  </button>
                  <button
                    type="button"
                    className={iconActionClass}
                    aria-label={`History for ${t.name}`}
                    title="Run history"
                    onClick={() => setHistoryToolName(t.name)}
                  >
                    <MaterialSymbol name="history" className="text-[22px]" />
                  </button>
                  {restrictedView ? (
                    <button
                      type="button"
                      className={iconActionClass}
                      aria-label={`Restore access for ${t.name}`}
                      title="Restore organization access"
                      onClick={() => void patchToolPolicy(t.name, true)}
                    >
                      <MaterialSymbol name="verified_user" className="text-[22px]" />
                    </button>
                  ) : (
                    <button
                      type="button"
                      className={iconActionDangerClass}
                      aria-label={`Restrict ${t.name} for organization`}
                      title="Restrict for organization"
                      onClick={() => void patchToolPolicy(t.name, false)}
                    >
                      <MaterialSymbol name="block" className="text-[22px]" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!loading && filteredTools.length === 0 && !error ? (
        <p className={`${gridTop} text-center text-on-surface-variant`}>{filterEmptyHint}</p>
      ) : null}

      {!loading && disabledTools.length > 0 && availabilityFilter !== "org_restricted" ? (
        <section className={`${intro === "dashboard" ? "mt-10" : "mt-12"} border-t border-outline-variant pt-10`}>
          <h2 className="text-lg font-bold tracking-tight text-on-surface">Restricted for your organization</h2>
          <p className="mt-1 max-w-prose text-[13px] text-on-surface-variant">
            Tenant administrators can restore access without changing the underlying agent catalog.
          </p>
          <ul className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {disabledTools.map((t) => (
              <li
                key={t.name}
                className="flex flex-col rounded-2xl border border-outline-variant bg-surface-container-low px-4 py-3 shadow-sm"
              >
                <p className="font-mono text-[15px] font-bold text-on-surface">{t.name}</p>
                <p className="mt-1 line-clamp-2 text-[12px] leading-snug text-on-surface-variant">
                  {getToolCardTeaser(t) || "—"}
                </p>
                <button
                  type="button"
                  className="mt-3 inline-flex items-center justify-center gap-2 self-start rounded-xl bg-primary px-4 py-2 text-[13px] font-semibold text-on-primary transition hover:bg-primary-dim"
                  onClick={() => void patchToolPolicy(t.name, true)}
                >
                  <MaterialSymbol name="verified_user" className="text-[20px]" />
                  Restore access
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
