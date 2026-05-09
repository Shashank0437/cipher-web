"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowUp, Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AgentChatMarkdown } from "@/components/dashboard/AgentChatMarkdown";
import { DashboardHeaderProfile } from "@/components/dashboard/DashboardHeaderProfile";
import { AgentChatExecModeDropdown } from "@/components/dashboard/AgentChatExecModeDropdown";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import type { AuthUser } from "@/lib/auth-context";
import {
  createAgentChatSession,
  deleteAgentChatSession,
  fetchAgentChatOrgTools,
  listAgentChatMessages,
  listAgentChatSessions,
  patchAgentChatToolBatchDecisions,
  type AgentChatMessage,
  type AgentChatSession,
  type AgentChatSseEvent,
  type AgentChatToolExecutionMode,
  streamAgentChatMessage,
  streamAgentChatToolBatchExecute,
  streamAgentChatToolConfirm,
} from "@/lib/agentChat";
import { ApiError } from "@/lib/api";

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

/** Distance-from-bottom threshold to treat transcript as “following” newest content */
const TRANSCRIPT_BOTTOM_PIN_PX = 64;

function formatChatError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}

function batchAwaitingQuorum(m: AgentChatMessage): boolean {
  const slots = m.tool_calls;
  return Array.isArray(slots) && slots.length > 0 && m.batch_execution_state === "awaiting_quorum";
}

function batchQuorumMet(m: AgentChatMessage): boolean {
  if (!batchAwaitingQuorum(m)) return false;
  const slots = m.tool_calls!;
  return slots.every((s) => {
    const d = String(s.human_decision ?? "").toLowerCase();
    return d === "approve" || d === "reject";
  });
}

function batchHasApprovedSlot(m: AgentChatMessage): boolean {
  const slots = m.tool_calls;
  if (!Array.isArray(slots)) return false;
  return slots.some((s) => String(s.human_decision ?? "").toLowerCase() === "approve");
}

/** Chevron-down used after “Thought”; rotates 180° when `<details>` is open. */
function ThoughtDropdownChevron({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M6 9l6 6 6-6"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const PROMPT_INPUT_PLACEHOLDER =
  "Objective, targets, constraints — agents & tools from the bar below";

type ClaudePromptBoxProps = {
  textareaId: string;
  prompt: string;
  onPromptChange: (value: string) => void;
  onExecute: () => void;
  isSending: boolean;
  onOpenToolPicker: () => void;
  explicitToolNamesCount: number;
  toolExecutionMode: AgentChatToolExecutionMode;
  onToolExecutionModeChange: (v: AgentChatToolExecutionMode) => void;
};

function CipherStrikeClaudePromptBox({
  textareaId,
  prompt,
  onPromptChange,
  onExecute,
  isSending,
  onOpenToolPicker,
  explicitToolNamesCount,
  toolExecutionMode,
  onToolExecutionModeChange,
}: ClaudePromptBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cannotSubmit = !prompt.trim() || isSending;
  const sendButtonDisabled = !prompt.trim() && !isSending;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!cannotSubmit) onExecute();
    }
  };

  const pillBase =
    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 py-2 text-left text-[12px] font-semibold shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-primary/30 sm:gap-2 sm:text-[13px]";

  return (
    <div className="overflow-hidden rounded-[1.75rem] border border-outline-variant/55 bg-surface-container-lowest shadow-[0_22px_56px_-30px_rgba(49,39,89,0.42),inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-black/[0.05] transition-colors focus-within:border-primary/40 focus-within:shadow-[0_26px_60px_-28px_rgba(49,39,89,0.52),0_0_0_3px_rgba(104,76,182,0.11)] focus-within:ring-primary/20 sm:rounded-[2rem]">
      <div className="relative">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[5.25rem] bg-gradient-to-b from-primary/[0.09] via-primary/[0.03] to-transparent sm:h-[6rem]"
          aria-hidden
        />
        <label htmlFor={textareaId} className="sr-only">
          Mission prompt
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          rows={4}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PROMPT_INPUT_PLACEHOLDER}
          className="relative z-[1] min-h-[7.25rem] w-full resize-none bg-transparent px-5 pb-2 pt-5 text-[15px] leading-relaxed text-on-surface placeholder:font-medium placeholder:text-on-surface-variant/48 focus:outline-none focus:ring-0 sm:min-h-[7.75rem]"
        />
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-outline-variant/55 bg-surface-container-low/95 px-2.5 py-2.5 backdrop-blur-[10px] supports-[backdrop-filter]:bg-surface-container-low/82 sm:gap-3 sm:px-4 sm:py-3">
        <div
          className="-mx-0.5 flex min-w-0 flex-1 items-center gap-2 overflow-x-auto px-0.5 [scrollbar-width:none] sm:gap-2.5 [&::-webkit-scrollbar]:hidden"
          role="toolbar"
          aria-label="Prompt attachments"
        >
          <button
            type="button"
            onClick={() => textareaRef.current?.focus()}
            aria-label="Focus mission prompt"
            className={`${pillBase} items-center border-outline-variant/80 bg-surface-container-high/90 text-on-surface hover:border-primary/35 hover:bg-primary-container/55`}
          >
            <MaterialSymbol name="smart_toy" className="text-[18px] text-primary" filled />
            <span>Agent</span>
          </button>
          <button
            type="button"
            onClick={onOpenToolPicker}
            aria-label={
              explicitToolNamesCount ? `${explicitToolNamesCount} tools pinned, choose tools` : "Choose tools"
            }
            className={`${pillBase} items-center border-outline-variant/80 hover:border-primary/35 hover:bg-primary-container/40 ${
              explicitToolNamesCount
                ? "border-primary/30 bg-primary-container/45 text-primary"
                : "bg-surface-container-high/90 text-on-surface"
            }`}
          >
            <MaterialSymbol name="build" className="text-[18px] opacity-[0.92]" aria-hidden filled />
            <span className="whitespace-nowrap">Tool</span>
            {explicitToolNamesCount ? (
              <span className="rounded-full bg-primary/18 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-primary">
                {explicitToolNamesCount}
              </span>
            ) : null}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2 sm:gap-2.5">
          <AgentChatExecModeDropdown
            compact
            menuAlign="end"
            value={toolExecutionMode}
            onChange={onToolExecutionModeChange}
          />
          <button
            type="button"
            onClick={onExecute}
            disabled={sendButtonDisabled}
            aria-label={isSending ? "Executing" : "Execute"}
            aria-busy={isSending}
            className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/35 ${
              isSending || prompt.trim()
                ? "bg-primary text-on-primary shadow-[0_4px_14px_-6px_rgba(104,76,182,0.65)] hover:opacity-[0.93]"
                : "cursor-not-allowed bg-surface-container-high text-on-surface-variant ring-1 ring-outline-variant/85"
            }`}
          >
            {isSending ? (
              <Loader2 className="size-[1.125rem] animate-spin stroke-[2.75]" aria-hidden stroke="currentColor" />
            ) : (
              <ArrowUp className="size-[1.125rem] stroke-[2.75]" aria-hidden stroke="currentColor" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

export function InitializeOffensiveSequencePage({ user }: { user: AuthUser }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const openFreshChatFlag = searchParams.get("new");

  const [prompt, setPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [streamPreview, setStreamPreview] = useState("");
  const [streamReasoning, setStreamReasoning] = useState("");
  const [reasoningStreaming, setReasoningStreaming] = useState(false);
  const [streamThoughtSeconds, setStreamThoughtSeconds] = useState<number | null>(null);
  const [toolExecutionMode, setToolExecutionMode] = useState<AgentChatToolExecutionMode>("ask_permission");
  const [explicitToolNames, setExplicitToolNames] = useState<string[] | null>(null);
  const [toolPickerOpen, setToolPickerOpen] = useState(false);
  const [orgToolsRows, setOrgToolsRows] = useState<{ name: string; description: string }[]>([]);
  const [orgToolsLoading, setOrgToolsLoading] = useState(false);
  const [orgToolsErr, setOrgToolsErr] = useState<string | null>(null);
  const [pickerSearch, setPickerSearch] = useState("");
  const [pickerChecked, setPickerChecked] = useState<Record<string, boolean>>({});

  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  /** Inner wrapper used with ResizeObserver so layout growth still triggers follow-scroll when pinned */
  const scrollContentRef = useRef<HTMLDivElement | null>(null);
  const reasoningStartedAtRef = useRef<number | null>(null);
  /** Skip auto-selecting the newest session once after `?new=1` so Run Scan opens an empty composer. */
  const skipAutosSelectRef = useRef(false);

  /** When true, streaming and message updates snap the transcript to bottom */
  const [pinnedToBottom, setPinnedToBottom] = useState(true);
  const pinnedToBottomRef = useRef(true);
  pinnedToBottomRef.current = pinnedToBottom;

  const isTenantAdmin = user.roles.includes("tenant_admin");

  const computePinnedFromElement = useCallback((el: HTMLDivElement) => {
    const { scrollTop, scrollHeight, clientHeight } = el;
    return scrollHeight - scrollTop - clientHeight < TRANSCRIPT_BOTTOM_PIN_PX;
  }, []);

  const scrollTranscriptToBottom = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, []);

  const handleScrollContainerScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    setPinnedToBottom(computePinnedFromElement(el));
  }, [computePinnedFromElement]);

  const handleScrollToBottomClick = useCallback(() => {
    setPinnedToBottom(true);
    requestAnimationFrame(() => {
      scrollTranscriptToBottom();
    });
  }, [scrollTranscriptToBottom]);

  const refreshSessions = useCallback(async () => {
    try {
      setListErr(null);
      const rows = await listAgentChatSessions();
      setSessions(rows);
      return rows;
    } catch (e) {
      setListErr(formatChatError(e));
      return [];
    }
  }, []);

  const refreshMessages = useCallback(async (sessionId: string, opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    try {
      if (!silent) {
        setMessagesLoading(true);
        setActionErr(null);
      }
      const rows = await listAgentChatMessages(sessionId);
      setMessages(rows);
    } catch (e) {
      setActionErr(formatChatError(e));
    } finally {
      if (!silent) {
        setMessagesLoading(false);
      }
    }
  }, []);

  const captureThoughtDuration = useCallback(() => {
    const start = reasoningStartedAtRef.current;
    if (start === null) return;
    const sec = Math.round(((performance.now() - start) / 1000) * 10) / 10;
    reasoningStartedAtRef.current = null;
    setStreamThoughtSeconds(Math.max(0.1, sec));
  }, []);

  const resetThoughtClock = useCallback(() => {
    reasoningStartedAtRef.current = null;
    setStreamThoughtSeconds(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const wantsFresh =
      openFreshChatFlag === "1" || openFreshChatFlag === "true" || openFreshChatFlag === "";

    (async () => {
      setSessionsLoading(true);
      const rows = await refreshSessions();
      if (cancelled) return;
      setSessionsLoading(false);

      if (wantsFresh) {
        abortRef.current?.abort();
        skipAutosSelectRef.current = true;
        setSelectedSessionId(null);
        setMessages([]);
        setPrompt("");
        setStreamPreview("");
        setStreamReasoning("");
        setReasoningStreaming(false);
        resetThoughtClock();
        setExplicitToolNames(null);
        router.replace("/dashboard/scan", { scroll: false });
        return;
      }

      if (skipAutosSelectRef.current) {
        skipAutosSelectRef.current = false;
        return;
      }

      setSelectedSessionId((prev) => prev ?? (rows[0]?.id ?? null));
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions, openFreshChatFlag, router, resetThoughtClock]);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      return;
    }
    void refreshMessages(selectedSessionId);
  }, [selectedSessionId, refreshMessages]);

  useEffect(() => {
    setPinnedToBottom(true);
  }, [selectedSessionId]);

  useEffect(() => {
    if (!pinnedToBottom) return;
    const id = window.requestAnimationFrame(() => {
      scrollTranscriptToBottom();
    });
    return () => cancelAnimationFrame(id);
  }, [
    pinnedToBottom,
    messages,
    streamPreview,
    streamReasoning,
    reasoningStreaming,
    scrollTranscriptToBottom,
  ]);

  useEffect(() => {
    const contentRoot = scrollContentRef.current;
    if (!contentRoot || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!pinnedToBottomRef.current) return;
      requestAnimationFrame(() => {
        scrollTranscriptToBottom();
      });
    });
    ro.observe(contentRoot);
    return () => ro.disconnect();
  }, [scrollTranscriptToBottom]);

  useEffect(() => {
    if (!toolPickerOpen || orgToolsRows.length === 0) return;
    const names = orgToolsRows.map((r) => r.name);
    if (explicitToolNames === null) {
      setPickerChecked(Object.fromEntries(names.map((n) => [n, true])));
    } else {
      const sel = new Set(explicitToolNames);
      setPickerChecked(Object.fromEntries(names.map((n) => [n, sel.has(n)])));
    }
  }, [toolPickerOpen, orgToolsRows, explicitToolNames]);

  useEffect(() => {
    if (!toolPickerOpen) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") setToolPickerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toolPickerOpen]);

  const loadOrgTools = useCallback(async () => {
    setOrgToolsLoading(true);
    setOrgToolsErr(null);
    try {
      const rows = await fetchAgentChatOrgTools();
      setOrgToolsRows(rows);
    } catch (e) {
      setOrgToolsErr(formatChatError(e));
    } finally {
      setOrgToolsLoading(false);
    }
  }, []);

  const handleOpenToolPicker = useCallback(() => {
    setPickerSearch("");
    setToolPickerOpen(true);
    void loadOrgTools();
  }, [loadOrgTools]);

  const handleApplyToolPicker = useCallback(() => {
    const names = orgToolsRows.map((r) => r.name);
    if (names.length === 0) {
      setExplicitToolNames(null);
      setToolPickerOpen(false);
      return;
    }
    const selected = names.filter((n) => pickerChecked[n]);
    if (selected.length === 0 || selected.length === names.length) {
      setExplicitToolNames(null);
    } else {
      setExplicitToolNames([...selected].sort((a, b) => a.localeCompare(b)));
    }
    setToolPickerOpen(false);
  }, [orgToolsRows, pickerChecked]);

  const toolPickerFiltered = orgToolsRows.filter((r) => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      (r.description && r.description.toLowerCase().includes(q))
    );
  });

  const onCardClick = useCallback((seed: string) => {
    setPrompt((p) => (p.trim() ? `${p.trim()}\n${seed}` : seed));
  }, []);

  const handleDeleteSession = useCallback(
    async (sessionId: string, e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!window.confirm("Delete this chat permanently?")) return;
      try {
        setActionErr(null);
        if (selectedSessionId === sessionId) {
          abortRef.current?.abort();
        }
        await deleteAgentChatSession(sessionId);
        const rows = await refreshSessions();
        if (selectedSessionId === sessionId) {
          setSelectedSessionId(rows[0]?.id ?? null);
        }
      } catch (err) {
        setActionErr(formatChatError(err));
      }
    },
    [selectedSessionId, refreshSessions],
  );

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setActionErr(null);
    router.replace("/dashboard/scan?new=1", { scroll: false });
  }, [router]);

  const attachStreamHandlers = useCallback(
    (sessionId: string) => (ev: AgentChatSseEvent) => {
      if (ev.type === "thinking") {
        setReasoningStreaming(true);
        if (reasoningStartedAtRef.current === null) reasoningStartedAtRef.current = performance.now();
        return;
      }
      if (ev.type === "thinking_token") {
        setReasoningStreaming(true);
        if (reasoningStartedAtRef.current === null) reasoningStartedAtRef.current = performance.now();
        setStreamReasoning((prev) => prev + ev.text);
        return;
      }
      if (ev.type === "token") {
        captureThoughtDuration();
        setReasoningStreaming(false);
        setStreamPreview((prev) => prev + ev.text);
        return;
      }
      if (ev.type === "tool_pending") {
        captureThoughtDuration();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } finally {
            setReasoningStreaming(false);
            setStreamReasoning("");
            setStreamPreview("");
          }
        })();
        return;
      }
      if (ev.type === "tool_batch_pending") {
        captureThoughtDuration();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } finally {
            setReasoningStreaming(false);
            setStreamReasoning("");
            setStreamPreview("");
          }
        })();
        return;
      }
      if (ev.type === "error") {
        captureThoughtDuration();
        setActionErr(ev.message);
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
          } finally {
            setReasoningStreaming(false);
            setStreamReasoning("");
            setStreamPreview("");
          }
        })();
        return;
      }
      if (ev.type === "done") {
        captureThoughtDuration();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } finally {
            setReasoningStreaming(false);
            setStreamReasoning("");
            setStreamPreview("");
          }
        })();
      }
    },
    [captureThoughtDuration, refreshMessages, refreshSessions],
  );

  const handleExecute = useCallback(async () => {
    const text = prompt.trim();
    if (!text || isSending) return;

    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    let sessionId = selectedSessionId;
    try {
      setActionErr(null);
      if (!sessionId) {
        const s = await createAgentChatSession("");
        sessionId = s.id;
        setSessions((prev) => [s, ...prev]);
        setSelectedSessionId(s.id);
      }

      setPrompt("");
      setIsSending(true);
      setPinnedToBottom(true);
      setStreamPreview("");
      setStreamReasoning("");
      setReasoningStreaming(false);
      resetThoughtClock();

      await streamAgentChatMessage(sessionId, text, {
        signal: ac.signal,
        toolExecutionMode,
        explicitToolNames,
        onEvent: attachStreamHandlers(sessionId),
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        setReasoningStreaming(false);
        setStreamReasoning("");
        setStreamPreview("");
        return;
      }
      setPrompt(text);
      setActionErr(formatChatError(e));
      if (sessionId) await refreshMessages(sessionId);
    } finally {
      setIsSending(false);
    }
  }, [
    prompt,
    isSending,
    selectedSessionId,
    attachStreamHandlers,
    refreshMessages,
    toolExecutionMode,
    explicitToolNames,
    resetThoughtClock,
  ]);

  const handleToolConfirm = useCallback(
    async (assistantMessageId: string, approved: boolean) => {
      if (!selectedSessionId || confirmingId) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        setConfirmingId(assistantMessageId);
        setActionErr(null);
        setStreamPreview("");
        setStreamReasoning("");
        setReasoningStreaming(false);
        resetThoughtClock();

        await streamAgentChatToolConfirm(selectedSessionId, assistantMessageId, approved, {
          signal: ac.signal,
          onEvent: attachStreamHandlers(selectedSessionId),
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setStreamPreview("");
          setStreamReasoning("");
          setReasoningStreaming(false);
          return;
        }
        setActionErr(formatChatError(e));
        await refreshMessages(selectedSessionId, { silent: true });
      } finally {
        setConfirmingId(null);
      }
    },
    [selectedSessionId, confirmingId, attachStreamHandlers, refreshMessages, resetThoughtClock],
  );

  const patchBatchDecisions = useCallback(
    async (messageId: string, decisions: Record<string, string>) => {
      if (!selectedSessionId) return;
      try {
        setActionErr(null);
        await patchAgentChatToolBatchDecisions(selectedSessionId, messageId, decisions);
        await refreshMessages(selectedSessionId, { silent: true });
      } catch (e) {
        setActionErr(formatChatError(e));
      }
    },
    [selectedSessionId, refreshMessages],
  );

  const handleBatchExecute = useCallback(
    async (assistantMessageId: string) => {
      if (!selectedSessionId || confirmingId) return;
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        setConfirmingId(assistantMessageId);
        setActionErr(null);
        setStreamPreview("");
        setStreamReasoning("");
        setReasoningStreaming(false);
        resetThoughtClock();

        await streamAgentChatToolBatchExecute(selectedSessionId, assistantMessageId, {
          signal: ac.signal,
          onEvent: attachStreamHandlers(selectedSessionId),
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") {
          setStreamPreview("");
          setStreamReasoning("");
          setReasoningStreaming(false);
          return;
        }
        setActionErr(formatChatError(e));
        await refreshMessages(selectedSessionId, { silent: true });
      } finally {
        setConfirmingId(null);
      }
    },
    [selectedSessionId, confirmingId, attachStreamHandlers, refreshMessages, resetThoughtClock],
  );

  const hasThread =
    selectedSessionId !== null ||
    messages.length > 0 ||
    streamPreview.length > 0 ||
    streamReasoning.length > 0 ||
    reasoningStreaming ||
    isSending ||
    confirmingId;

  return (
    <div className="flex h-dvh max-h-dvh min-h-0 flex-col overflow-hidden bg-background font-sans text-on-surface md:flex-row">
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
      <aside className="hidden min-h-0 w-[272px] min-w-[272px] shrink-0 flex-col overflow-hidden border-r border-outline-variant bg-surface-container-low md:flex">
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
          <div className="mt-4 flex max-h-[min(420px,50vh)] flex-col gap-1 overflow-y-auto pr-1">
            {sessionsLoading ? (
              <p className="text-[13px] text-on-surface-variant">Loading…</p>
            ) : listErr ? (
              <p className="text-[13px] text-error">{listErr}</p>
            ) : sessions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-outline-variant/80 bg-surface-container-lowest/80 px-4 py-8 text-center">
                <p className="text-[13px] leading-relaxed text-on-surface-variant">
                  No chats yet. Start with New chat below.
                </p>
              </div>
            ) : (
              sessions.map((s) => {
                const sel = selectedSessionId === s.id;
                return (
                  <div
                    key={s.id}
                    className={`group flex items-stretch gap-0.5 rounded-lg ${
                      sel ? "bg-primary-container ring-1 ring-primary/20" : ""
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedSessionId(s.id)}
                      className={`min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px] font-medium transition-colors ${
                        sel ? "text-on-primary-container" : "text-on-surface-variant hover:bg-surface-container"
                      }`}
                    >
                      {s.title || "Chat"}
                    </button>
                    <button
                      type="button"
                      onClick={(e) => void handleDeleteSession(s.id, e)}
                      disabled={sessionsLoading}
                      title="Delete chat"
                      aria-label={`Delete chat ${s.title || "Chat"}`}
                      className={`flex shrink-0 items-center justify-center rounded-md px-2 py-2 transition-colors disabled:opacity-40 ${
                        sel
                          ? "text-on-primary-container hover:bg-black/10"
                          : "text-on-surface-variant opacity-80 hover:bg-surface-container hover:opacity-100 md:opacity-0 md:group-hover:opacity-100"
                      }`}
                    >
                      <MaterialSymbol name="delete" className="text-lg" aria-hidden />
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="shrink-0 border-t border-outline-variant/80 p-5">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary py-3 text-sm font-bold text-on-primary shadow-sm transition hover:opacity-92 active:scale-[0.99]"
            onClick={() => void handleNewChat()}
          >
            <MaterialSymbol name="edit_square" className="text-lg text-on-primary" filled />
            New chat
          </button>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-40 flex shrink-0 items-start justify-between gap-4 border-b border-outline-variant bg-background/95 px-4 py-4 backdrop-blur-sm sm:px-6 lg:px-8 xl:px-10">
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

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 min-w-0 w-full flex-1 flex-col px-4 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] sm:px-6 sm:pt-6 sm:pb-8 lg:px-8 lg:pt-8 lg:pb-9 xl:px-10">
            <div
              className={
                hasThread
                  ? "relative flex min-h-0 min-w-0 flex-1 flex-col"
                  : "relative flex min-h-0 min-w-0 flex-1 flex-col gap-4"
              }
            >
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {/* flex-col + min-h-0 so flex-1 on the scroll area actually constrains height (otherwise transcript collapses / clips and looks “inside” the composer). */}
            <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
            <div
              ref={scrollContainerRef}
              onScroll={handleScrollContainerScroll}
              className={
                hasThread
                  ? "min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth px-3 pb-3 pt-3 sm:px-5 sm:pb-4 sm:pt-4 lg:px-7 lg:pb-5 lg:pt-5"
                  : "min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-smooth"
              }
            >
              <div ref={scrollContentRef}>
              {actionErr ? (
                <div className="mb-4 rounded-xl border border-error/40 bg-error/10 px-4 py-3 text-[13px] text-error">
                  {actionErr}
                </div>
              ) : null}

              {!hasThread ? (
                <div className="mx-auto flex w-full max-w-2xl flex-col items-center px-1 sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl">
                  <div className="flex w-full flex-col items-center text-center">
                    <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary-container shadow-sm ring-1 ring-primary/15">
                      <MaterialSymbol name="hub" className="text-3xl text-primary" filled />
                    </div>
                    <h2 className="mt-5 text-2xl font-bold tracking-tight text-on-surface md:text-[1.65rem]">
                      Initialize Offensive Sequence
                    </h2>
                    <p className="mt-2 max-w-lg text-[15px] leading-relaxed text-on-surface-variant">
                      Deploy specialized agents to perform deep reconnaissance, vulnerability analysis, or automated
                      exploit crafting.
                    </p>
                  </div>

                  <div className="mt-8 grid w-full grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
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

                  <p className="mt-6 max-w-xl text-center text-[13px] leading-snug text-on-surface-variant">
                    Use the <span className="font-semibold text-on-surface">Agent</span> /{" "}
                    <span className="font-semibold text-on-surface">Tool</span> pills in the prompt bar, then Execute.
                  </p>
                </div>
              ) : (
                <div className="mx-auto flex min-w-0 w-[min(100%,70%)] flex-col gap-4 pb-2">
                  {messagesLoading && messages.length === 0 ? (
                    <p className="text-[13px] text-on-surface-variant">Loading messages…</p>
                  ) : null}
                  {messages.map((m) => (
                    <div
                      key={m.id}
                      className={`flex flex-col gap-2 ${
                        m.role === "user"
                          ? "ml-auto max-w-[min(88%,26rem)] sm:max-w-[min(82%,34rem)] items-end"
                          : "mr-auto w-full max-w-[min(100%,48rem)] sm:max-w-[min(100%,52rem)] lg:max-w-[min(100%,58rem)] xl:max-w-[min(100%,62rem)] items-start"
                      }`}
                    >
                      {m.role === "assistant" && (m.thinking_content ?? "").trim() ? (
                        <details className="group w-full">
                          <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-left text-[13px] text-on-surface-variant marker:content-none hover:text-on-surface [&::-webkit-details-marker]:hidden">
                            <span>Thought</span>
                            <ThoughtDropdownChevron className="shrink-0 text-on-surface-variant transition-transform duration-200 group-open:rotate-180" />
                          </summary>
                          <div className="mt-1 max-h-[min(260px,38vh)] overflow-y-auto border-l-2 border-outline-variant/60 pl-3 text-[13px] leading-relaxed text-on-surface-variant">
                            <AgentChatMarkdown text={(m.thinking_content ?? "").trim()} />
                          </div>
                        </details>
                      ) : null}
                      <div
                        className={
                          m.role === "user"
                            ? "rounded-[1.35rem] bg-primary-container px-4 py-2.5 text-[14px] leading-relaxed text-on-primary-container"
                            : m.role === "tool"
                              ? "border-l-2 border-outline-variant/45 py-2 pl-3 font-mono text-[12px] leading-relaxed text-on-surface-variant"
                              : "py-1 text-[15px] leading-[1.75] text-on-surface"
                        }
                      >
                        {m.role === "assistant" ? (
                          <AgentChatMarkdown text={m.content} />
                        ) : (
                          <p className="whitespace-pre-wrap break-words">{m.content}</p>
                        )}
                      </div>
                      {m.role === "assistant" && batchAwaitingQuorum(m) ? (
                        <div className="w-full max-w-lg rounded-xl border border-primary/25 bg-primary-container/30 px-4 py-3">
                          <p className="text-[12px] font-bold text-primary">Tool batch — approve or reject each slot</p>
                          <p className="mt-1 text-[11px] text-on-surface-variant">
                            Every slot needs a decision before execution. Partial choices are saved but nothing runs until
                            you choose for all tools and tap Execute batch.
                          </p>
                          <div className="mt-3 flex flex-wrap gap-2 border-t border-outline-variant/40 pt-3">
                            <button
                              type="button"
                              disabled={confirmingId !== null}
                              onClick={() => {
                                const slots = m.tool_calls ?? [];
                                const decisions = Object.fromEntries(
                                  slots.map((s, i) => [String(s.slot_index ?? i), "approve"]),
                                );
                                void patchBatchDecisions(m.id, decisions);
                              }}
                              className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 text-[12px] font-semibold text-on-surface disabled:opacity-45"
                            >
                              Approve all
                            </button>
                            <button
                              type="button"
                              disabled={confirmingId !== null}
                              onClick={() => {
                                const slots = m.tool_calls ?? [];
                                const decisions = Object.fromEntries(
                                  slots.map((s, i) => [String(s.slot_index ?? i), "reject"]),
                                );
                                void patchBatchDecisions(m.id, decisions);
                              }}
                              className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1.5 text-[12px] font-semibold text-on-surface disabled:opacity-45"
                            >
                              Reject all
                            </button>
                          </div>
                          <ul className="mt-3 flex flex-col gap-3">
                            {(m.tool_calls ?? []).map((slot, i) => {
                              const idx = slot.slot_index ?? i;
                              const decided = String(slot.human_decision ?? "").toLowerCase();
                              const isAp = decided === "approve";
                              const isRej = decided === "reject";
                              return (
                                <li
                                  key={`${m.id}-${idx}`}
                                  className="rounded-lg border border-outline-variant/70 bg-surface-container-lowest/90 p-3"
                                >
                                  <p className="font-mono text-[11px] font-bold text-on-surface">
                                    {String(slot.tool_name ?? "")}
                                  </p>
                                  <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-surface-container-lowest p-2 text-[10px] text-on-surface">
                                    {JSON.stringify(slot.arguments ?? {}, null, 2)}
                                  </pre>
                                  <div className="mt-2 flex flex-wrap gap-2">
                                    <button
                                      type="button"
                                      disabled={confirmingId !== null}
                                      onClick={() =>
                                        void patchBatchDecisions(m.id, { [String(idx)]: "approve" })
                                      }
                                      className={`rounded-full px-3 py-1.5 text-[12px] font-bold disabled:opacity-45 ${
                                        isAp
                                          ? "bg-primary text-on-primary"
                                          : "border border-outline-variant bg-surface-container-high text-on-surface"
                                      }`}
                                    >
                                      Accept
                                    </button>
                                    <button
                                      type="button"
                                      disabled={confirmingId !== null}
                                      onClick={() =>
                                        void patchBatchDecisions(m.id, { [String(idx)]: "reject" })
                                      }
                                      className={`rounded-full px-3 py-1.5 text-[12px] font-semibold disabled:opacity-45 ${
                                        isRej
                                          ? "border-2 border-error bg-error/15 text-error"
                                          : "border border-outline-variant bg-surface-container-high text-on-surface"
                                      }`}
                                    >
                                      Reject
                                    </button>
                                    {isAp || isRej ? (
                                      <span className="self-center text-[11px] text-on-surface-variant">
                                        {isAp ? "Approved" : "Rejected"}
                                      </span>
                                    ) : (
                                      <span className="self-center text-[11px] text-on-surface-variant">
                                        Undecided
                                      </span>
                                    )}
                                  </div>
                                </li>
                              );
                            })}
                          </ul>
                          <div className="mt-4 border-t border-outline-variant/40 pt-3">
                            <button
                              type="button"
                              disabled={
                                confirmingId !== null ||
                                !batchQuorumMet(m) ||
                                (!isTenantAdmin && batchHasApprovedSlot(m))
                              }
                              title={
                                !batchQuorumMet(m)
                                  ? "Choose approve or reject for every tool first"
                                  : !isTenantAdmin && batchHasApprovedSlot(m)
                                    ? "Tenant administrator role required when any tool is approved"
                                    : "Run approved tools"
                              }
                              onClick={() => void handleBatchExecute(m.id)}
                              className="rounded-full bg-primary px-4 py-2 text-[13px] font-bold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              {confirmingId === m.id ? "Running…" : "Execute batch"}
                            </button>
                            {!isTenantAdmin && batchHasApprovedSlot(m) && batchQuorumMet(m) ? (
                              <p className="mt-2 text-[11px] text-on-surface-variant">
                                Running approved tools requires the tenant administrator role. Reject-all avoids this.
                              </p>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                      {m.role === "assistant" &&
                      m.tool_call &&
                      String(m.tool_call.state) === "pending" &&
                      !batchAwaitingQuorum(m) ? (
                        <div className="w-full max-w-md rounded-xl border border-primary/25 bg-primary-container/30 px-4 py-3">
                          <p className="text-[12px] font-bold text-primary">Tool approval required</p>
                          <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
                            {String(m.tool_call.tool_name ?? "")}
                          </p>
                          <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-surface-container-lowest p-2 text-[11px] text-on-surface">
                            {JSON.stringify(m.tool_call.arguments ?? {}, null, 2)}
                          </pre>
                          <div className="mt-3 flex flex-wrap gap-2">
                            <button
                              type="button"
                              disabled={!isTenantAdmin || confirmingId !== null}
                              title={
                                isTenantAdmin
                                  ? "Run this tool via the NyxStrike agent"
                                  : "Tenant administrator role required"
                              }
                              onClick={() => void handleToolConfirm(m.id, true)}
                              className="rounded-full bg-primary px-4 py-2 text-[13px] font-bold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
                            >
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={confirmingId !== null}
                              onClick={() => void handleToolConfirm(m.id, false)}
                              className="rounded-full border border-outline-variant bg-surface-container-high px-4 py-2 text-[13px] font-semibold text-on-surface disabled:opacity-45"
                            >
                              Reject
                            </button>
                          </div>
                          {!isTenantAdmin ? (
                            <p className="mt-2 text-[11px] text-on-surface-variant">
                              Approvals require the tenant administrator role. You can still reject.
                            </p>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {(reasoningStreaming || streamReasoning.length > 0) && (
                    <details className="group mr-auto w-full max-w-[min(100%,48rem)] sm:max-w-[min(100%,52rem)] lg:max-w-[min(100%,58rem)] xl:max-w-[min(100%,62rem)]">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-left text-[13px] text-on-surface-variant marker:content-none hover:text-on-surface [&::-webkit-details-marker]:hidden">
                        <span>
                          {reasoningStreaming
                            ? "Thinking…"
                            : streamThoughtSeconds != null
                              ? `Thought for ${streamThoughtSeconds}s`
                              : "Thought"}
                        </span>
                        <ThoughtDropdownChevron className="shrink-0 text-on-surface-variant transition-transform duration-200 group-open:rotate-180" />
                      </summary>
                      <div className="mt-1 max-h-[min(260px,38vh)] overflow-y-auto border-l-2 border-outline-variant/60 pl-3 text-[13px] leading-relaxed text-on-surface-variant">
                        <AgentChatMarkdown text={streamReasoning} />
                        {reasoningStreaming ? (
                          <span className="ml-0.5 inline-block h-3 w-1 animate-pulse rounded-sm bg-primary align-middle" />
                        ) : null}
                      </div>
                    </details>
                  )}
                  {streamPreview ? (
                    <div className="mr-auto w-full max-w-[min(100%,48rem)] sm:max-w-[min(100%,52rem)] lg:max-w-[min(100%,58rem)] xl:max-w-[min(100%,62rem)] py-1 text-[15px] leading-[1.75] text-on-surface">
                      <AgentChatMarkdown text={streamPreview} />
                      <span className="mt-0.5 inline-block h-3 w-1 animate-pulse rounded-full bg-primary align-middle" />
                    </div>
                  ) : null}
                  <div ref={bottomRef} />
                </div>
              )}
              </div>
            </div>
            {hasThread && !pinnedToBottom ? (
              <button
                type="button"
                onClick={handleScrollToBottomClick}
                title="Jump to latest"
                aria-label="Scroll to bottom of conversation"
                className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-outline-variant bg-surface-container-lowest text-primary shadow-md ring-1 ring-primary/10 transition hover:border-primary/40 hover:bg-primary-container/85 sm:bottom-5"
              >
                <MaterialSymbol name="south" className="block text-[22px] leading-none" filled />
              </button>
            ) : null}
            </div>

            {hasThread ? (
              <div className="shrink-0 border-t border-outline-variant/50 px-3 py-4 sm:px-5 sm:py-5 lg:px-7">
                <div className="mx-auto w-[min(100%,60%)] min-w-0">
                  <CipherStrikeClaudePromptBox
                    textareaId="offensive-prompt"
                    prompt={prompt}
                    onPromptChange={setPrompt}
                    onExecute={() => void handleExecute()}
                    isSending={isSending}
                    onOpenToolPicker={() => void handleOpenToolPicker()}
                    explicitToolNamesCount={explicitToolNames?.length ?? 0}
                    toolExecutionMode={toolExecutionMode}
                    onToolExecutionModeChange={setToolExecutionMode}
                  />
                </div>
              </div>
            ) : null}
            </div>

          {!hasThread ? (
          <div className="mx-auto w-[min(100%,60%)] min-w-0 shrink-0 px-1 pb-0 pt-3">
            <CipherStrikeClaudePromptBox
              textareaId="offensive-prompt-empty"
              prompt={prompt}
              onPromptChange={setPrompt}
              onExecute={() => void handleExecute()}
              isSending={isSending}
              onOpenToolPicker={() => void handleOpenToolPicker()}
              explicitToolNamesCount={explicitToolNames?.length ?? 0}
              toolExecutionMode={toolExecutionMode}
              onToolExecutionModeChange={setToolExecutionMode}
            />
          </div>
          ) : null}
          </div>
          </div>

          {toolPickerOpen ? (
            <div
              className="fixed inset-0 z-[70] flex items-end justify-center bg-black/45 p-4 sm:items-center"
              role="presentation"
              onClick={() => setToolPickerOpen(false)}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="tool-picker-title"
                className="pointer-events-auto flex max-h-[min(560px,88vh)] w-full max-w-lg flex-col rounded-2xl border border-outline-variant bg-surface-container-lowest shadow-xl ring-1 ring-black/[0.04]"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-outline-variant/80 px-5 py-4">
                  <div>
                    <h2 id="tool-picker-title" className="text-base font-bold text-on-surface">
                      Tools for this chat
                    </h2>
                    <p className="mt-1 text-[12px] leading-snug text-on-surface-variant">
                      Only org-enabled tools are listed. Uncheck tools to narrow what the assistant may call — this
                      overrides automatic tool routing from your prompt. Leave all checked for default behavior.
                    </p>
                  </div>
                  <button
                    type="button"
                    className="rounded-full p-2 text-on-surface-variant hover:bg-surface-container-high"
                    aria-label="Close"
                    onClick={() => setToolPickerOpen(false)}
                  >
                    <MaterialSymbol name="close" className="text-xl" />
                  </button>
                </div>

                <div className="shrink-0 border-b border-outline-variant/60 px-5 py-3">
                  <input
                    type="search"
                    value={pickerSearch}
                    onChange={(e) => setPickerSearch(e.target.value)}
                    placeholder="Search tools…"
                    className="w-full rounded-xl border border-outline-variant bg-surface-container-high px-3 py-2 text-[14px] text-on-surface outline-none placeholder:text-on-surface-variant/70 focus:border-primary/40"
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 text-[12px] font-semibold text-on-surface"
                      onClick={() => {
                        const names = orgToolsRows.map((r) => r.name);
                        setPickerChecked(Object.fromEntries(names.map((n) => [n, true])));
                      }}
                    >
                      Select all
                    </button>
                    <button
                      type="button"
                      className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 text-[12px] font-semibold text-on-surface"
                      onClick={() => {
                        const names = orgToolsRows.map((r) => r.name);
                        setPickerChecked(Object.fromEntries(names.map((n) => [n, false])));
                      }}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      disabled={orgToolsLoading}
                      className="rounded-full border border-outline-variant bg-surface-container-high px-3 py-1 text-[12px] font-semibold text-on-surface disabled:opacity-45"
                      onClick={() => void loadOrgTools()}
                    >
                      Refresh list
                    </button>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
                  {orgToolsLoading && orgToolsRows.length === 0 ? (
                    <p className="px-2 py-8 text-center text-[13px] text-on-surface-variant">Loading tools…</p>
                  ) : null}
                  {orgToolsErr ? (
                    <p className="px-2 py-4 text-center text-[13px] text-error">{orgToolsErr}</p>
                  ) : null}
                  {!orgToolsLoading && orgToolsRows.length === 0 && !orgToolsErr ? (
                    <p className="px-2 py-8 text-center text-[13px] text-on-surface-variant">
                      No tools available for your organization.
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-1 pb-2">
                    {toolPickerFiltered.map((row) => (
                      <li key={row.name}>
                        <label className="flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 hover:bg-surface-container-high/90">
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 shrink-0 rounded border-outline-variant text-primary"
                            checked={Boolean(pickerChecked[row.name])}
                            onChange={() =>
                              setPickerChecked((prev) => ({
                                ...prev,
                                [row.name]: !prev[row.name],
                              }))
                            }
                          />
                          <span className="min-w-0">
                            <span className="font-mono text-[13px] font-bold text-on-surface">{row.name}</span>
                            {row.description ? (
                              <span className="mt-0.5 block text-[12px] leading-snug text-on-surface-variant">
                                {row.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-outline-variant/80 px-5 py-4">
                  <button
                    type="button"
                    className="rounded-full px-4 py-2 text-[13px] font-semibold text-on-surface-variant hover:bg-surface-container-high"
                    onClick={() => setToolPickerOpen(false)}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    disabled={orgToolsLoading || (!!orgToolsErr && orgToolsRows.length === 0)}
                    className="rounded-full bg-primary px-5 py-2 text-[13px] font-bold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
                    onClick={() => handleApplyToolPicker()}
                  >
                    Apply
                  </button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
