"use client";

import { Fragment, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { AgentChatAttachment } from "../../lib/agentChat";

// Components are now built dynamically within AgentChatMarkdown using useMemo to support attachment downloading

/** Matches persisted assistant tool rows; fence is 3+ backticks, same length open/close (CommonMark). */
const TOOL_EXEC_MARKDOWN_BLOCK_RE =
  /\[Tool executed: \*\*([^\*]+)\*\*\]\s*\nArguments: `([^`]*)`\s*\nResult:\s*\n(`{3,})json\s*\n([\s\S]*?)\n\3/g;

/** JSON payload inside the first ``[Tool executed: …] Result:`` fence, or null. */
export function extractToolResultJsonFromExecContent(content: string): string | null {
  const re = new RegExp(TOOL_EXEC_MARKDOWN_BLOCK_RE.source);
  const m = re.exec(content);
  return m && m[4] != null ? m[4].trim() : null;
}

type ParsedSegment =
  | { type: "markdown"; text: string }
  | { type: "tool"; toolName: string; argsRaw: string; fullBlock: string };

function parseToolExecutionRecords(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  let last = 0;
  const re = new RegExp(TOOL_EXEC_MARKDOWN_BLOCK_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      segments.push({ type: "markdown", text: text.slice(last, m.index) });
    }
    segments.push({
      type: "tool",
      toolName: m[1].trim(),
      argsRaw: m[2],
      fullBlock: m[0],
    });
    last = m.index + m[0].length;
  }
  if (last < text.length) {
    segments.push({ type: "markdown", text: text.slice(last) });
  }
  return segments;
}

function truncateOneLine(s: string, maxChars: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

function ToolDetailsChevron({ className }: { className?: string }) {
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

type Props = {
  text: string;
  className?: string;
  /** When true (default), each complete `[Tool executed: **…**] … ```json` block is wrapped in collapsed `<details>`. */
  collapseToolExecutions?: boolean;
  attachments?: AgentChatAttachment[] | null;
  onDownloadAttachment?: (attachmentId: string, filename: string) => void;
};

/** Renders model text as Markdown (bold, lists, code, links). Safe: no raw HTML execution. */
export function AgentChatMarkdown({
  text,
  className,
  collapseToolExecutions = true,
  attachments,
  onDownloadAttachment,
}: Props) {
  const trimmed = text.trim();

  const components = useMemo<Components>(() => ({
    p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
    strong: ({ children }) => <strong className="font-semibold text-inherit">{children}</strong>,
    em: ({ children }) => <em className="italic">{children}</em>,
    ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
    li: ({ children }) => <li className="leading-relaxed">{children}</li>,
    code: ({ className, children, ...props }) => {
      const block = Boolean(className);
      if (block) {
        return (
          <code
            className="block min-w-0 max-h-[min(320px,50vh)] overflow-x-hidden overflow-y-auto whitespace-pre-wrap break-words break-all rounded-lg bg-surface-container-high px-3 py-2 font-mono text-[12px] text-on-surface [overflow-wrap:anywhere]"
            {...props}
          >
            {children}
          </code>
        );
      }
      return (
        <code className="rounded bg-surface-container-high px-1 py-0.5 font-mono text-[0.9em]" {...props}>
          {children}
        </code>
      );
    },
    pre: ({ children }) => <pre className="my-2">{children}</pre>,
    h1: ({ children }) => <h3 className="mb-1 mt-3 text-base font-bold text-inherit">{children}</h3>,
    h2: ({ children }) => <h4 className="mb-1 mt-2 text-[15px] font-bold text-inherit">{children}</h4>,
    h3: ({ children }) => <h5 className="mb-0 mt-2 text-[14px] font-semibold text-inherit">{children}</h5>,
    a: ({ href, children }) => {
      const decodedHref = href ? decodeURIComponent(href).trim() : "";
      const isHttp = decodedHref.toLowerCase().startsWith("http://") || decodedHref.toLowerCase().startsWith("https://");

      const matchingAttachment =
        !isHttp &&
        attachments &&
        attachments.find((a) => {
          const fname = a.filename ? a.filename.trim().toLowerCase() : "";
          const decodedLower = decodedHref.toLowerCase();
          return (
            fname &&
            (decodedLower === fname ||
              decodedLower.endsWith("/" + fname) ||
              fname.endsWith("/" + decodedLower))
          );
        });

      if (matchingAttachment && onDownloadAttachment) {
        return (
          <a
            href="#"
            className="text-primary underline underline-offset-2 cursor-pointer font-semibold"
            onClick={(e) => {
              e.preventDefault();
              onDownloadAttachment(matchingAttachment.id, matchingAttachment.filename);
            }}
          >
            {children}
          </a>
        );
      }

      return (
        <a
          href={href}
          className="text-primary underline underline-offset-2"
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
    blockquote: ({ children }) => (
      <blockquote className="border-l-2 border-outline-variant pl-3 italic text-on-surface-variant">
        {children}
      </blockquote>
    ),
    hr: () => <hr className="my-3 border-outline-variant/60" />,
  }), [attachments, onDownloadAttachment]);
  if (!trimmed) return null;

  if (!collapseToolExecutions) {
    return (
      <div className={className}>
        <ReactMarkdown components={components}>{trimmed}</ReactMarkdown>
      </div>
    );
  }

  const segments = parseToolExecutionRecords(trimmed);
  const onlyMarkdown =
    segments.length === 0 ||
    (segments.length === 1 && segments[0].type === "markdown");

  if (onlyMarkdown) {
    return (
      <div className={className}>
        <ReactMarkdown components={components}>{trimmed}</ReactMarkdown>
      </div>
    );
  }

  return (
    <div className={className}>
      {segments.map((seg, i) => {
        if (seg.type === "markdown") {
          const md = seg.text.trim();
          if (!md) return null;
          return (
            <Fragment key={`md-${i}`}>
              <ReactMarkdown components={components}>{md}</ReactMarkdown>
            </Fragment>
          );
        }
        const argsPreview = truncateOneLine(seg.argsRaw, 72);
        const summaryTitle = argsPreview ? `Tool: ${seg.toolName} · ${argsPreview}` : `Tool: ${seg.toolName}`;
        return (
          <details
            key={`tool-${i}`}
            open
            className="group my-2 w-full min-w-0 overflow-hidden rounded-lg border border-outline-variant/45 bg-surface-container-lowest/70 ring-1 ring-outline-variant/30"
          >
            <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-left text-[13px] text-on-surface-variant marker:content-none hover:text-on-surface [&::-webkit-details-marker]:hidden">
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]" title={summaryTitle}>
                {summaryTitle}
              </span>
              <ToolDetailsChevron className="shrink-0 text-on-surface-variant transition-transform duration-200 group-open:rotate-180" />
            </summary>
            <div className="min-w-0 max-h-[min(320px,50vh)] overflow-y-auto border-t border-outline-variant/35 px-2 py-2">
              <ReactMarkdown components={components}>{seg.fullBlock}</ReactMarkdown>
            </div>
          </details>
        );
      })}
    </div>
  );
}
