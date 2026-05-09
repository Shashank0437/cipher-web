"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Loader2, Terminal } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { AgentChatMarkdown, extractToolResultJsonFromExecContent } from "@/components/dashboard/AgentChatMarkdown";
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
  type AgentChatBatchSlot,
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

/** Same JSON is stored on the assistant ``[Tool executed: …]`` row and again as a ``tool`` message — hide the duplicate row in the transcript. */
function isRedundantToolResultEcho(previousMessage: AgentChatMessage | undefined, toolContent: string): boolean {
  if (!previousMessage || previousMessage.role !== "assistant") return false;
  const prev = previousMessage.content ?? "";
  if (!prev.includes("[Tool executed:")) return false;
  const embedded = extractToolResultJsonFromExecContent(prev);
  if (embedded == null) return false;
  const tool = toolContent.trim();
  if (embedded === tool) return true;
  try {
    return JSON.stringify(JSON.parse(embedded)) === JSON.stringify(JSON.parse(tool));
  } catch {
    return false;
  }
}

/** LLM follow-up sometimes pastes the same raw tool JSON as its own assistant message — hide that duplicate bubble. */
function getLatestToolJsonPayloadBefore(messages: AgentChatMessage[], beforeIdx: number): string | null {
  for (let j = beforeIdx - 1; j >= 0; j--) {
    const msg = messages[j];
    if (msg.role === "tool") {
      const t = (msg.content ?? "").trim();
      if (t) return t;
    }
    if (msg.role === "user") return null;
    if (msg.role === "assistant") {
      const extracted = extractToolResultJsonFromExecContent(msg.content ?? "");
      if (extracted) return extracted;
      continue;
    }
  }
  return null;
}

function isEchoAssistantToolJsonDuplicate(messages: AgentChatMessage[], idx: number): boolean {
  const m = messages[idx];
  if (m.role !== "assistant") return false;
  const c = m.content ?? "";
  if (c.includes("[Tool executed:")) return false;
  const body = c.trim();
  if (!body) return false;
  let compare = body;
  const fenced = body.match(/^(`{3,})json\s*\n([\s\S]*)\n\1\s*$/);
  if (fenced) compare = fenced[2].trim();
  const first = compare[0];
  if (first !== "{" && first !== "[") return false;
  const prior = getLatestToolJsonPayloadBefore(messages, idx);
  if (!prior) return false;
  try {
    return JSON.stringify(JSON.parse(compare)) === JSON.stringify(JSON.parse(prior));
  } catch {
    return compare === prior.trim();
  }
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

function batchDecidedCount(m: AgentChatMessage): number {
  const slots = m.tool_calls;
  if (!Array.isArray(slots)) return 0;
  return slots.filter((s) => {
    const d = String(s.human_decision ?? "").toLowerCase();
    return d === "approve" || d === "reject";
  }).length;
}

function batchPanelOpen(m: AgentChatMessage): boolean {
  const st = m.batch_execution_state ?? "";
  return (
    Array.isArray(m.tool_calls) &&
    m.tool_calls.length > 0 &&
    (st === "awaiting_quorum" || st === "executing" || st === "completed")
  );
}

function mergeBatchSlotOverlay(
  messageId: string,
  slotIndex: number,
  slot: AgentChatBatchSlot,
  overlay: Record<string, Partial<AgentChatBatchSlot>>,
): AgentChatBatchSlot {
  const row = overlay[`${messageId}-${slotIndex}`];
  return row ? { ...slot, ...row } : slot;
}

/** Single pending tool_call uses logical slot index 0 for SSE `[TOOL_BATCH_SLOT_PROGRESS]`. */
function singleToolSlotFromMessage(m: AgentChatMessage): AgentChatBatchSlot {
  const tc = m.tool_call;
  return {
    slot_index: 0,
    tool_name: tc?.tool_name ?? "",
    arguments: tc?.arguments,
    endpoint: tc?.endpoint,
    description: tc?.description,
    run_status: tc?.run_status ?? undefined,
    stdout_tail: tc?.stdout_tail ?? undefined,
    stderr_tail: tc?.stderr_tail ?? undefined,
    stdout_truncated: tc?.stdout_truncated,
    stderr_truncated: tc?.stderr_truncated,
    exit_code: tc?.exit_code ?? undefined,
    http_status: tc?.http_status ?? undefined,
    run_started_at: tc?.run_started_at ?? undefined,
    run_finished_at: tc?.run_finished_at ?? undefined,
  };
}

function BatchRunStatusChip({ batchState, slot }: { batchState: string; slot: AgentChatBatchSlot }) {
  if (batchState === "awaiting_quorum") return null;
  const rs = String(slot.run_status ?? "").toLowerCase();
  if (!rs) {
    return <span className="text-[10px] text-on-surface-variant">—</span>;
  }
  if (rs === "running") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-primary px-2 py-0.5 text-[10px] font-bold text-on-primary shadow-sm">
        <Loader2 className="size-3 shrink-0 animate-spin" aria-hidden strokeWidth={2.5} />
        <span>Running…</span>
      </span>
    );
  }
  if (rs === "queued") {
    return (
      <span className="inline-flex items-center gap-1 rounded-md border border-primary/35 bg-primary-container px-2 py-0.5 text-[10px] font-semibold text-primary">
        <Loader2 className="size-3 shrink-0 animate-pulse opacity-80" aria-hidden strokeWidth={2.5} />
        <span>Queued…</span>
      </span>
    );
  }
  const cls =
    rs === "done"
      ? "border border-emerald-800/35 bg-emerald-700 text-white shadow-sm dark:border-emerald-400/50 dark:bg-emerald-500 dark:text-emerald-950"
      : rs === "error"
        ? "bg-error/15 text-error"
        : rs === "skipped"
          ? "bg-outline-variant/40 text-on-surface-variant"
          : "bg-surface-container-high text-on-surface";
  return <span className={`rounded-md px-1.5 py-0 text-[10px] font-semibold capitalize ${cls}`}>{rs}</span>;
}

function BatchExecLogPanel({ slot }: { slot: AgentChatBatchSlot }) {
  const out = (slot.stdout_tail ?? "").trim();
  const err = (slot.stderr_tail ?? "").trim();
  const meta: string[] = [];
  if (slot.http_status != null && Number.isFinite(Number(slot.http_status))) {
    meta.push(`HTTP ${slot.http_status}`);
  }
  if (slot.exit_code != null && slot.exit_code !== undefined) {
    meta.push(`exit ${slot.exit_code}`);
  }
  const times: string[] = [];
  if (slot.run_started_at) times.push(`started ${slot.run_started_at}`);
  if (slot.run_finished_at) times.push(`finished ${slot.run_finished_at}`);

  const hasBody = Boolean(out || err);
  const hasMeta = meta.length > 0 || times.length > 0;
  if (!hasBody && !hasMeta) return null;

  return (
    <details className="mt-1.5 overflow-hidden rounded-lg bg-surface-container-lowest/90 ring-1 ring-outline-variant/45">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-[10px] font-semibold text-primary [&::-webkit-details-marker]:hidden">
        <Terminal className="size-3.5 shrink-0 opacity-90" aria-hidden strokeWidth={2} />
        <span>Execution log</span>
        {slot.stdout_truncated || slot.stderr_truncated ? (
          <span className="text-[9px] font-normal text-on-surface-variant">(truncated)</span>
        ) : null}
      </summary>
      <div className="space-y-2 border-t border-outline-variant/35 px-2 py-2">
        {hasMeta ? (
          <p className="font-mono text-[9px] leading-relaxed text-on-surface-variant">
            {[...meta, ...times].join(" · ")}
          </p>
        ) : null}
        {out ? (
          <div>
            <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-on-surface-variant">stdout</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-black/[0.04] p-2 font-mono text-[10px] leading-snug text-on-surface dark:bg-white/[0.06]">
              {slot.stdout_tail ?? ""}
            </pre>
          </div>
        ) : null}
        {err ? (
          <div>
            <p className="mb-0.5 text-[9px] font-bold uppercase tracking-wide text-error">stderr</p>
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-error/8 p-2 font-mono text-[10px] leading-snug text-on-surface">
              {slot.stderr_tail ?? ""}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function compactToolArgsPreview(args: unknown): string {
  try {
    const s = JSON.stringify(args ?? {});
    return s.length > 88 ? `${s.slice(0, 85)}…` : s;
  } catch {
    return "";
  }
}

/**
 * Three dots with staggered bounce for “agent still working” in the composer strip.
 */
function AgentWorkingDots({ className }: { className?: string }) {
  const dot =
    "inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-duration:0.55s]";
  return (
    <span className={`inline-flex h-4 shrink-0 items-end gap-[3px] ${className ?? ""}`} aria-hidden>
      <span className={`${dot} [animation-delay:0ms]`} />
      <span className={`${dot} [animation-delay:120ms]`} />
      <span className={`${dot} [animation-delay:240ms]`} />
    </span>
  );
}

function AgentWorkingComposerStrip() {
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="flex w-full items-center gap-2 rounded-xl border border-primary/30 bg-primary-container/95 px-3 py-2.5 text-[12px] font-semibold leading-snug text-primary shadow-md backdrop-blur-sm"
    >
      <AgentWorkingDots className="text-primary" />
      <span>
        Agent is working — you can keep this tab open; replies and tool output appear here when ready.
      </span>
    </div>
  );
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
  /** When false, “Auto accept” is disabled (must match tenant admin on the server). */
  allowAutoAcceptTools?: boolean;
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
  allowAutoAcceptTools = true,
}: ClaudePromptBoxProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cannotSubmit = !prompt.trim() || isSending;
  const sendButtonDisabled = cannotSubmit;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (!cannotSubmit) onExecute();
    }
  };

  const pillBase =
    "inline-flex shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2.5 py-1.5 text-left text-[11px] font-semibold shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-primary/30 sm:gap-1.5 sm:px-3 sm:py-1.5 sm:text-[12px]";

  return (
    <div className="rounded-[1.25rem] border border-outline-variant/55 bg-surface-container-lowest shadow-[0_14px_40px_-24px_rgba(49,39,89,0.38),inset_0_1px_0_rgba(255,255,255,0.75)] ring-1 ring-black/[0.04] transition-colors focus-within:border-primary/40 focus-within:shadow-[0_18px_44px_-22px_rgba(49,39,89,0.48),0_0_0_2px_rgba(104,76,182,0.1)] focus-within:ring-primary/18 sm:rounded-[1.4rem]">
      <div className="relative overflow-hidden rounded-t-[1.25rem] sm:rounded-t-[1.4rem]">
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-0 h-12 bg-gradient-to-b from-primary/[0.07] via-primary/[0.02] to-transparent sm:h-14"
          aria-hidden
        />
        <label htmlFor={textareaId} className="sr-only">
          Mission prompt
        </label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          rows={3}
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={PROMPT_INPUT_PLACEHOLDER}
          className="relative z-[1] min-h-[4.5rem] w-full resize-none bg-transparent px-3.5 pb-1.5 pt-3.5 text-[14px] leading-snug text-on-surface placeholder:font-medium placeholder:text-on-surface-variant/48 focus:outline-none focus:ring-0 sm:min-h-[5rem] sm:px-4 sm:pt-4"
        />
      </div>
      <div className="relative z-20 flex items-center justify-between gap-1.5 overflow-visible rounded-b-[1.25rem] border-t border-outline-variant/55 bg-surface-container-low/95 px-2 py-1.5 backdrop-blur-[10px] supports-[backdrop-filter]:bg-surface-container-low/82 sm:gap-2 sm:rounded-b-[1.4rem] sm:px-3 sm:py-2">
        <div
          className="-mx-0.5 flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-0.5 [scrollbar-width:none] sm:gap-2 [&::-webkit-scrollbar]:hidden"
          role="toolbar"
          aria-label="Prompt attachments"
        >
          <button
            type="button"
            onClick={() => textareaRef.current?.focus()}
            aria-label="Focus mission prompt"
            className={`${pillBase} items-center border-outline-variant/80 bg-surface-container-high/90 text-on-surface hover:border-primary/35 hover:bg-primary-container/55`}
          >
            <MaterialSymbol name="smart_toy" className="text-[16px] text-primary" filled />
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
            <MaterialSymbol name="build" className="text-[16px] opacity-[0.92]" aria-hidden filled />
            <span className="whitespace-nowrap">Tool</span>
            {explicitToolNamesCount ? (
              <span className="rounded-full bg-primary/18 px-1 py-0.5 text-[9px] font-bold tabular-nums text-primary sm:px-1.5 sm:text-[10px]">
                {explicitToolNamesCount}
              </span>
            ) : null}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 sm:gap-2">
          <AgentChatExecModeDropdown
            compact
            menuAlign="end"
            allowAutoAccept={allowAutoAcceptTools}
            value={toolExecutionMode}
            onChange={onToolExecutionModeChange}
          />
          <button
            type="button"
            onClick={onExecute}
            disabled={sendButtonDisabled}
            aria-label={isSending ? "Executing" : "Execute"}
            aria-busy={isSending}
            className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary/35 ${
              isSending || prompt.trim()
                ? "bg-primary text-on-primary shadow-[0_3px_12px_-5px_rgba(104,76,182,0.6)] hover:opacity-[0.93]"
                : "cursor-not-allowed bg-surface-container-high text-on-surface-variant ring-1 ring-outline-variant/85"
            }`}
          >
            {isSending ? (
              <Loader2 className="size-4 animate-spin stroke-[2.5]" aria-hidden stroke="currentColor" />
            ) : (
              <ArrowUp className="size-4 stroke-[2.5]" aria-hidden stroke="currentColor" />
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
  const chatIdParam = searchParams.get("chat_id");

  const [prompt, setPrompt] = useState("");
  const [sessions, setSessions] = useState<AgentChatSession[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<AgentChatMessage[]>([]);
  const [optimisticMessages, setOptimisticMessages] = useState<AgentChatMessage[]>([]);
  const [listErr, setListErr] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  /** PATCH …/tool-decisions in flight for this assistant message id */
  const [batchDecisionsBusyId, setBatchDecisionsBusyId] = useState<string | null>(null);
  /** Live merges from ``[TOOL_BATCH_SLOT_PROGRESS]`` SSE during batch execute (key: ``messageId-slotIndex``). */
  const [liveBatchSlotOverlay, setLiveBatchSlotOverlay] = useState<Record<string, Partial<AgentChatBatchSlot>>>({});
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
  const streamPreviewQueueRef = useRef("");
  const streamPreviewFlushTimerRef = useRef<number | null>(null);
  /** Debounce Mongo refresh when tool slots hit terminal status (before overall SSE `[DONE]`). */
  const toolSlotTerminalRefreshTimerRef = useRef<number | null>(null);
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
      setOptimisticMessages((prev) =>
        prev.filter((opt) => !rows.some((row) => row.role === opt.role && row.content === opt.content)),
      );
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

  const flushAllStreamPreview = useCallback(() => {
    const pending = streamPreviewQueueRef.current;
    if (!pending) return;
    streamPreviewQueueRef.current = "";
    setStreamPreview((prev) => prev + pending);
  }, []);

  const stopStreamPreviewFlush = useCallback(() => {
    if (streamPreviewFlushTimerRef.current !== null) {
      window.clearInterval(streamPreviewFlushTimerRef.current);
      streamPreviewFlushTimerRef.current = null;
    }
  }, []);

  const clearLiveStreamState = useCallback(() => {
    stopStreamPreviewFlush();
    streamPreviewQueueRef.current = "";
    setReasoningStreaming(false);
    setStreamReasoning("");
    setStreamPreview("");
    resetThoughtClock();
  }, [resetThoughtClock, stopStreamPreviewFlush]);

  const enqueueStreamPreview = useCallback(() => {
    const pending = streamPreviewQueueRef.current;
    if (pending) {
      const takeNow = Math.min(6, pending.length);
      streamPreviewQueueRef.current = pending.slice(takeNow);
      setStreamPreview((prev) => prev + pending.slice(0, takeNow));
    }
    if (streamPreviewFlushTimerRef.current !== null) return;
    streamPreviewFlushTimerRef.current = window.setInterval(() => {
      const pending = streamPreviewQueueRef.current;
      if (!pending) {
        stopStreamPreviewFlush();
        return;
      }
      const take = pending.length > 80 ? 16 : pending.length > 32 ? 10 : 6;
      streamPreviewQueueRef.current = pending.slice(take);
      setStreamPreview((prev) => prev + pending.slice(0, take));
    }, 24);
  }, [stopStreamPreviewFlush]);

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
        setOptimisticMessages([]);
        setPrompt("");
        setLiveBatchSlotOverlay({});
        clearLiveStreamState();
        setExplicitToolNames(null);
        router.replace("/dashboard/scan", { scroll: false });
        return;
      }

      if (skipAutosSelectRef.current) {
        skipAutosSelectRef.current = false;
        return;
      }

      const requestedChat = chatIdParam?.trim();
      const requested = requestedChat && rows.some((r) => r.id === requestedChat) ? requestedChat : null;
      setSelectedSessionId((prev) => prev ?? requested ?? (rows[0]?.id ?? null));
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions, openFreshChatFlag, chatIdParam, router, clearLiveStreamState]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (chatIdParam === selectedSessionId) return;
    router.replace(`/dashboard/scan?chat_id=${encodeURIComponent(selectedSessionId)}`, { scroll: false });
  }, [selectedSessionId, chatIdParam, router]);

  useEffect(() => {
    if (!selectedSessionId) {
      setMessages([]);
      setOptimisticMessages([]);
      return;
    }
    void refreshMessages(selectedSessionId);
  }, [selectedSessionId, refreshMessages]);

  useEffect(() => {
    setLiveBatchSlotOverlay({});
  }, [selectedSessionId]);

  useEffect(() => {
    return () => {
      if (toolSlotTerminalRefreshTimerRef.current !== null) {
        window.clearTimeout(toolSlotTerminalRefreshTimerRef.current);
        toolSlotTerminalRefreshTimerRef.current = null;
      }
    };
  }, [selectedSessionId]);

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
    liveBatchSlotOverlay,
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
        await refreshSessions();
        if (selectedSessionId === sessionId) {
          setSelectedSessionId(null);
          setMessages([]);
          setOptimisticMessages([]);
          clearLiveStreamState();
          router.replace("/dashboard/scan?new=1", { scroll: false });
        }
      } catch (err) {
        setActionErr(formatChatError(err));
      }
    },
    [clearLiveStreamState, router, selectedSessionId, refreshSessions],
  );

  const handleNewChat = useCallback(() => {
    abortRef.current?.abort();
    setActionErr(null);
    setSelectedSessionId(null);
    setMessages([]);
    setOptimisticMessages([]);
    setLiveBatchSlotOverlay({});
    clearLiveStreamState();
    router.replace("/dashboard/scan?new=1", { scroll: false });
  }, [clearLiveStreamState, router]);

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
        streamPreviewQueueRef.current += ev.text;
        enqueueStreamPreview();
        return;
      }
      if (ev.type === "tool_pending") {
        captureThoughtDuration();
        flushAllStreamPreview();
        clearLiveStreamState();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } catch (e) {
            setActionErr(formatChatError(e));
          }
        })();
        return;
      }
      if (ev.type === "tool_batch_pending") {
        captureThoughtDuration();
        flushAllStreamPreview();
        clearLiveStreamState();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } catch (e) {
            setActionErr(formatChatError(e));
          }
        })();
        return;
      }
      if (ev.type === "tool_batch_slot_progress") {
        const mid = typeof ev.payload.message_id === "string" ? ev.payload.message_id : "";
        const si = ev.payload.slot_index;
        if (!mid || typeof si !== "number") return;
        const payload = ev.payload as Record<string, unknown>;
        const { message_id: _m, ...rest } = payload;
        const key = `${mid}-${si}`;
        const rs = String(rest.run_status ?? "").toLowerCase();
        setLiveBatchSlotOverlay((prev) => ({
          ...prev,
          [key]: { ...prev[key], ...(rest as Partial<AgentChatBatchSlot>) },
        }));
        // Server persists confirmed slots / tool_call before LLM follow-up; refresh now so the approval
        // card does not stick until the entire follow-up stream finishes or the connection drops.
        if (rs === "done" || rs === "error" || rs === "skipped") {
          if (toolSlotTerminalRefreshTimerRef.current !== null) {
            window.clearTimeout(toolSlotTerminalRefreshTimerRef.current);
          }
          toolSlotTerminalRefreshTimerRef.current = window.setTimeout(() => {
            toolSlotTerminalRefreshTimerRef.current = null;
            void (async () => {
              try {
                await refreshMessages(sessionId, { silent: true });
              } catch (e) {
                setActionErr(formatChatError(e));
              }
            })();
          }, 120);
        }
        return;
      }
      if (ev.type === "error") {
        captureThoughtDuration();
        setActionErr(ev.message);
        clearLiveStreamState();
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
          } catch (e) {
            setActionErr(formatChatError(e));
          }
        })();
        return;
      }
      if (ev.type === "done") {
        captureThoughtDuration();
        flushAllStreamPreview();
        stopStreamPreviewFlush();
        streamPreviewQueueRef.current = "";
        setReasoningStreaming(false);
        setStreamReasoning("");
        resetThoughtClock();
        setLiveBatchSlotOverlay({});
        void (async () => {
          try {
            await refreshMessages(sessionId, { silent: true });
            await refreshSessions();
          } catch (e) {
            setActionErr(formatChatError(e));
          } finally {
            setStreamPreview("");
          }
        })();
        return;
      }
    },
    [
      captureThoughtDuration,
      clearLiveStreamState,
      enqueueStreamPreview,
      flushAllStreamPreview,
      refreshMessages,
      refreshSessions,
      resetThoughtClock,
      stopStreamPreviewFlush,
    ],
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
      clearLiveStreamState();
      setReasoningStreaming(true);
      reasoningStartedAtRef.current = performance.now();
      setOptimisticMessages([
        {
          id: `optimistic-user-${Date.now()}`,
          role: "user",
          content: text,
          created_at: new Date().toISOString(),
        },
      ]);

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
        setOptimisticMessages([]);
        return;
      }
      setPrompt(text);
      setOptimisticMessages([]);
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
    clearLiveStreamState,
    refreshMessages,
    toolExecutionMode,
    explicitToolNames,
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
        setBatchDecisionsBusyId(messageId);
        setActionErr(null);
        await patchAgentChatToolBatchDecisions(selectedSessionId, messageId, decisions);
        await refreshMessages(selectedSessionId, { silent: true });
      } catch (e) {
        setActionErr(formatChatError(e));
      } finally {
        setBatchDecisionsBusyId(null);
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

  const visibleMessages = optimisticMessages.length > 0 ? [...messages, ...optimisticMessages] : messages;
  const streamPreviewText = streamPreview.trim();
  const persistedAssistantHasStreamPreview =
    streamPreviewText.length > 0 &&
    visibleMessages.some((m) => m.role === "assistant" && m.content.trim() === streamPreviewText);
  const visibleStreamPreview = persistedAssistantHasStreamPreview ? "" : streamPreview;

  const batchToolsRunning = visibleMessages.some(
    (m) =>
      m.role === "assistant" &&
      String(m.batch_execution_state ?? "").toLowerCase() === "executing",
  );
  const agentActivelyWorking =
    isSending ||
    confirmingId !== null ||
    reasoningStreaming ||
    batchToolsRunning ||
    visibleStreamPreview.trim().length > 0;

  const hasThread =
    selectedSessionId !== null ||
    visibleMessages.length > 0 ||
    visibleStreamPreview.length > 0 ||
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
                  {messagesLoading && visibleMessages.length === 0 ? (
                    <p className="text-[13px] text-on-surface-variant">Loading messages…</p>
                  ) : null}
                  {visibleMessages.map((m, idx) => {
                    if (m.role === "tool" && isRedundantToolResultEcho(visibleMessages[idx - 1], m.content)) {
                      return null;
                    }
                    if (m.role === "assistant" && isEchoAssistantToolJsonDuplicate(visibleMessages, idx)) {
                      return null;
                    }
                    return (
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
                      {m.role === "assistant" &&
                      (m.router_category?.trim() || m.keyword_category?.trim()) ? (
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-outline-variant/45 bg-surface-container-lowest/70 px-2.5 py-1.5 text-[11px] text-on-surface-variant">
                          <span className="font-semibold uppercase tracking-wide text-on-surface-variant/80">
                            Routing
                          </span>
                          {m.router_category?.trim() ? (
                            <span
                              className="rounded-md bg-primary/14 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary"
                              title="Workflow category from route-intent LLM"
                            >
                              router: {m.router_category.trim()}
                            </span>
                          ) : null}
                          {m.keyword_category?.trim() ? (
                            <span
                              className="rounded-md bg-surface-container-high px-1.5 py-0.5 font-mono text-[11px] text-on-surface"
                              title="classify-task keyword score + optional cheap LLM tie-break"
                            >
                              keyword: {m.keyword_category.trim()}
                              {typeof m.keyword_confidence === "number"
                                ? ` (${m.keyword_confidence.toFixed(2)})`
                                : ""}
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                      <div
                        className={
                          m.role === "user"
                            ? "rounded-[1.35rem] bg-primary-container px-4 py-2.5 text-[14px] leading-relaxed text-on-primary-container"
                            : m.role === "tool"
                              ? "min-w-0 max-w-full border-l-2 border-outline-variant/45 py-2 pl-3 font-mono text-[12px] leading-relaxed text-on-surface-variant [overflow-wrap:anywhere]"
                              : "py-1 text-[15px] leading-[1.75] text-on-surface"
                        }
                      >
                        {m.role === "assistant" ? (
                          <AgentChatMarkdown text={m.content} />
                        ) : (
                          <p className="whitespace-pre-wrap break-words break-all">{m.content}</p>
                        )}
                      </div>
                      {m.role === "assistant" && batchPanelOpen(m)
                        ? (() => {
                            const batchSt = m.batch_execution_state ?? "";
                            const showQuorum = batchSt === "awaiting_quorum";
                            const slotsList = m.tool_calls ?? [];
                            return (
                              <div className="flex w-full max-w-full flex-col overflow-hidden rounded-xl border border-primary/25 bg-primary-container/25 sm:max-w-[min(100%,40rem)] lg:max-w-[min(100%,48rem)]">
                                <div className="sticky top-0 z-[1] shrink-0 border-b border-outline-variant/45 bg-primary-container/55 px-3 py-2.5 backdrop-blur-sm sm:px-4">
                                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                    <div className="min-w-0">
                                      <p className="text-[12px] font-bold text-primary">Tool batch</p>
                                      {batchSt === "awaiting_quorum" ? (
                                        <p className="truncate text-[11px] text-on-surface-variant">
                                          {batchDecidedCount(m)} / {slotsList.length} decided · approve or reject each
                                          row, then Execute batch
                                        </p>
                                      ) : batchSt === "executing" ? (
                                        <p className="truncate text-[11px] text-on-surface-variant">
                                          Running approved tools in parallel…
                                        </p>
                                      ) : (
                                        <p className="truncate text-[11px] text-on-surface-variant">
                                          Batch finished · open execution logs per tool below
                                        </p>
                                      )}
                                    </div>
                                    {showQuorum ? (
                                      <div className="flex shrink-0 flex-wrap gap-1.5">
                                        <button
                                          type="button"
                                          disabled={confirmingId !== null || batchDecisionsBusyId === m.id}
                                          onClick={() => {
                                            const decisions = Object.fromEntries(
                                              slotsList.map((_s, i) => [String(i), "approve"]),
                                            );
                                            void patchBatchDecisions(m.id, decisions);
                                          }}
                                          className="rounded-lg border border-outline-variant bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface disabled:opacity-45"
                                        >
                                          {batchDecisionsBusyId === m.id ? "Saving…" : "Approve all"}
                                        </button>
                                        <button
                                          type="button"
                                          disabled={confirmingId !== null || batchDecisionsBusyId === m.id}
                                          onClick={() => {
                                            const decisions = Object.fromEntries(
                                              slotsList.map((_s, i) => [String(i), "reject"]),
                                            );
                                            void patchBatchDecisions(m.id, decisions);
                                          }}
                                          className="rounded-lg border border-outline-variant bg-surface-container-high px-2.5 py-1 text-[11px] font-semibold text-on-surface disabled:opacity-45"
                                        >
                                          {batchDecisionsBusyId === m.id ? "Saving…" : "Reject all"}
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                </div>

                                <ul className="max-h-[min(420px,52vh)] divide-y divide-outline-variant/35 overflow-y-auto overscroll-contain">
                                  {slotsList.map((slot, i) => {
                                    const decided = String(slot.human_decision ?? "").toLowerCase();
                                    const isAp = decided === "approve";
                                    const isRej = decided === "reject";
                                    const preview = compactToolArgsPreview(slot.arguments);
                                    const slotIdx = typeof slot.slot_index === "number" ? slot.slot_index : i;
                                    const merged = mergeBatchSlotOverlay(m.id, slotIdx, slot, liveBatchSlotOverlay);
                                    return (
                                      <li
                                        key={`${m.id}-slot-${i}`}
                                        className="flex flex-col gap-1.5 px-3 py-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3 sm:py-1.5 sm:pl-4 sm:pr-3"
                                      >
                                        <div className="min-w-0 flex-1">
                                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                                            <span className="font-mono text-[11px] font-bold text-on-surface">
                                              {String(slot.tool_name ?? "")}
                                            </span>
                                            {!showQuorum ? <BatchRunStatusChip batchState={batchSt} slot={merged} /> : null}
                                            {showQuorum ? (
                                              isAp ? (
                                                <span className="rounded-md bg-primary/18 px-1.5 py-0 text-[10px] font-semibold text-primary">
                                                  Approved
                                                </span>
                                              ) : isRej ? (
                                                <span className="rounded-md bg-error/12 px-1.5 py-0 text-[10px] font-semibold text-error">
                                                  Rejected
                                                </span>
                                              ) : (
                                                <span className="text-[10px] text-on-surface-variant">Pending</span>
                                              )
                                            ) : null}
                                          </div>
                                          {preview ? (
                                            <p
                                              className="truncate font-mono text-[10px] text-on-surface-variant/90"
                                              title={preview}
                                            >
                                              {preview}
                                            </p>
                                          ) : null}
                                          <details className="mt-0.5">
                                            <summary className="cursor-pointer select-none text-[10px] font-medium text-primary hover:underline">
                                              Full arguments
                                            </summary>
                                            <pre className="mt-1 max-h-28 overflow-auto rounded-md bg-surface-container-lowest/95 p-2 font-mono text-[10px] leading-snug text-on-surface ring-1 ring-outline-variant/40">
                                              {JSON.stringify(slot.arguments ?? {}, null, 2)}
                                            </pre>
                                          </details>
                                          {!showQuorum ? <BatchExecLogPanel slot={merged} /> : null}
                                        </div>
                                        {showQuorum ? (
                                          <div className="flex shrink-0 gap-1 sm:pt-0.5">
                                            <button
                                              type="button"
                                              disabled={confirmingId !== null || batchDecisionsBusyId === m.id}
                                              onClick={() => void patchBatchDecisions(m.id, { [String(i)]: "approve" })}
                                              className={`rounded-lg px-2 py-1 text-[11px] font-bold disabled:opacity-45 ${
                                                isAp
                                                  ? "bg-primary text-on-primary"
                                                  : "border border-outline-variant/80 bg-surface-container-high text-on-surface"
                                              }`}
                                            >
                                              Approve
                                            </button>
                                            <button
                                              type="button"
                                              disabled={confirmingId !== null || batchDecisionsBusyId === m.id}
                                              onClick={() => void patchBatchDecisions(m.id, { [String(i)]: "reject" })}
                                              className={`rounded-lg px-2 py-1 text-[11px] font-semibold disabled:opacity-45 ${
                                                isRej
                                                  ? "border border-error bg-error/12 text-error"
                                                  : "border border-outline-variant/80 bg-surface-container-high text-on-surface"
                                              }`}
                                            >
                                              Reject
                                            </button>
                                          </div>
                                        ) : null}
                                      </li>
                                    );
                                  })}
                                </ul>

                                {showQuorum ? (
                                  <div className="shrink-0 border-t border-outline-variant/45 bg-primary-container/30 px-3 py-2.5 sm:px-4">
                                    <button
                                      type="button"
                                      disabled={
                                        confirmingId !== null ||
                                        batchDecisionsBusyId === m.id ||
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
                                      className="rounded-lg bg-primary px-4 py-2 text-[12px] font-bold text-on-primary disabled:cursor-not-allowed disabled:opacity-45"
                                    >
                                      {confirmingId === m.id ? "Running…" : "Execute batch"}
                                    </button>
                                    {!isTenantAdmin && batchHasApprovedSlot(m) && batchQuorumMet(m) ? (
                                      <p className="mt-2 text-[11px] text-on-surface-variant">
                                        Running approved tools requires the tenant administrator role. Reject-all
                                        avoids this.
                                      </p>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            );
                          })()
                        : null}
                      {m.role === "assistant" &&
                      m.tool_call &&
                      String(m.tool_call.state) === "pending" &&
                      !batchPanelOpen(m)
                        ? (() => {
                            const mergedSingle = mergeBatchSlotOverlay(
                              m.id,
                              0,
                              singleToolSlotFromMessage(m),
                              liveBatchSlotOverlay,
                            );
                            /** Server keeps tool_call.state pending until finish; run_status is set when execution starts. */
                            const awaitingApproval = !String(mergedSingle.run_status ?? "").trim();
                            const showRunChip =
                              confirmingId === m.id ||
                              Boolean(String(mergedSingle.run_status ?? "").trim());
                            const runRs = String(mergedSingle.run_status ?? "").toLowerCase();
                            const isRunActive =
                              confirmingId === m.id || runRs === "running" || runRs === "queued";
                            return (
                              <div className="w-full max-w-md overflow-hidden rounded-xl border border-primary/25 bg-primary-container/30">
                                {isRunActive ? (
                                  <div
                                    className="h-1 w-full shrink-0 animate-pulse bg-primary"
                                    aria-hidden
                                  />
                                ) : null}
                                <div className="px-4 py-3">
                                <p className="text-[12px] font-bold text-primary">
                                  {awaitingApproval ? "Tool approval required" : "Tool execution"}
                                </p>
                                <p className="mt-1 font-mono text-[11px] text-on-surface-variant">
                                  {String(m.tool_call.tool_name ?? "")}
                                </p>
                                {awaitingApproval ? (
                                  <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-surface-container-lowest p-2 text-[11px] text-on-surface">
                                    {JSON.stringify(m.tool_call.arguments ?? {}, null, 2)}
                                  </pre>
                                ) : null}
                                {awaitingApproval ? (
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
                                      {confirmingId === m.id ? "Running…" : "Approve"}
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
                                ) : null}
                                {showRunChip ? (
                                  <div className="mt-2 flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-semibold uppercase tracking-wide text-on-surface-variant">
                                      Run
                                    </span>
                                    <BatchRunStatusChip
                                      batchState={confirmingId === m.id ? "executing" : "completed"}
                                      slot={mergedSingle}
                                    />
                                  </div>
                                ) : null}
                                <BatchExecLogPanel slot={mergedSingle} />
                                {awaitingApproval && !isTenantAdmin ? (
                                  <p className="mt-2 text-[11px] text-on-surface-variant">
                                    Approvals require the tenant administrator role. You can still reject.
                                  </p>
                                ) : null}
                                </div>
                              </div>
                            );
                          })()
                        : null}
                    </div>
                  );
                  })}
                  {(reasoningStreaming || streamReasoning.length > 0) && (
                    <details className="group mr-auto w-full max-w-[min(100%,48rem)] sm:max-w-[min(100%,52rem)] lg:max-w-[min(100%,58rem)] xl:max-w-[min(100%,62rem)]">
                      <summary className="flex cursor-pointer list-none items-center gap-1.5 py-1 text-left text-[13px] text-on-surface-variant marker:content-none hover:text-on-surface [&::-webkit-details-marker]:hidden">
                        {reasoningStreaming ? (
                          <Loader2
                            className="size-3.5 shrink-0 animate-spin text-primary"
                            aria-hidden
                            strokeWidth={2.5}
                          />
                        ) : null}
                        <span>
                          {reasoningStreaming
                            ? "Thinking..."
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
                  {visibleStreamPreview ? (
                    <div className="mr-auto w-full max-w-[min(100%,48rem)] sm:max-w-[min(100%,52rem)] lg:max-w-[min(100%,58rem)] xl:max-w-[min(100%,62rem)] py-1 text-[15px] leading-[1.75] text-on-surface">
                      <AgentChatMarkdown text={visibleStreamPreview} />
                      <span className="mt-0.5 inline-block h-3 w-1 animate-pulse rounded-full bg-primary align-middle" />
                    </div>
                  ) : null}
                  <div ref={bottomRef} />
                </div>
              )}
              </div>
            </div>
            {hasThread && !pinnedToBottom && !isSending && confirmingId === null ? (
              <button
                type="button"
                onClick={handleScrollToBottomClick}
                title="Jump to latest"
                aria-label="Scroll to bottom of conversation"
                className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex h-11 w-11 -translate-x-1/2 items-center justify-center rounded-full border border-outline-variant bg-surface-container-lowest text-primary shadow-md ring-1 ring-primary/10 transition hover:border-primary/40 hover:bg-primary-container/85 sm:bottom-5"
              >
                <ArrowDown className="size-[1.15rem] stroke-[2.5]" aria-hidden />
              </button>
            ) : null}
            </div>

            {hasThread ? (
              <div className="shrink-0 border-t border-outline-variant/50 px-3 py-4 sm:px-5 sm:py-5 lg:px-7">
                {agentActivelyWorking ? (
                  <div className="mx-auto mb-2 w-[min(100%,60%)] min-w-0">
                    <AgentWorkingComposerStrip />
                  </div>
                ) : null}
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
                    allowAutoAcceptTools={isTenantAdmin}
                  />
                </div>
              </div>
            ) : null}
            </div>

          {!hasThread ? (
          <div className="mx-auto w-[min(100%,60%)] min-w-0 shrink-0 px-1 pb-0 pt-3">
            {agentActivelyWorking ? (
              <div className="mb-2">
                <AgentWorkingComposerStrip />
              </div>
            ) : null}
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
              allowAutoAcceptTools={isTenantAdmin}
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
