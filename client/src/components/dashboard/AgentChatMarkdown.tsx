"use client";

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";

const components: Components = {
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
          className="block max-h-[min(320px,50vh)] overflow-x-auto overflow-y-auto rounded-lg bg-surface-container-high px-3 py-2 font-mono text-[12px] text-on-surface"
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
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-primary underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-outline-variant pl-3 italic text-on-surface-variant">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-outline-variant/60" />,
};

type Props = {
  text: string;
  className?: string;
};

/** Renders model text as Markdown (bold, lists, code, links). Safe: no raw HTML execution. */
export function AgentChatMarkdown({ text, className }: Props) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return (
    <div className={className}>
      <ReactMarkdown components={components}>{trimmed}</ReactMarkdown>
    </div>
  );
}
