import type { WorkspaceToolCard } from "@/components/tools/types";

const CARD_TEASER_MAX_LEN = 140;

function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function clampWithEllipsis(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1).trimEnd()}…`;
}

function teaserFromLongDescription(long: string): string {
  const oneLine = collapseWhitespace(long);
  if (!oneLine) return "";

  const sentenceMatch = oneLine.match(/^[\s\S]{1,4000}?[.!?](?=\s|$)/);
  const candidate = sentenceMatch ? sentenceMatch[0].trim() : oneLine;
  return clampWithEllipsis(candidate, CARD_TEASER_MAX_LEN);
}

/** Short blurb for grid cards and run modal. Prefer catalog `description`; else first sentence / clamp from `long_description`. Full copy belongs in ToolInfoModal. */
export function getToolCardTeaser(tool: WorkspaceToolCard): string {
  const short = tool.description?.trim();
  if (short) {
    const firstLine = short.split(/\r?\n/)[0]?.trim() ?? "";
    if (firstLine) return clampWithEllipsis(firstLine, CARD_TEASER_MAX_LEN);
  }
  const long = tool.long_description?.trim();
  if (long) return teaserFromLongDescription(long);
  return "";
}
