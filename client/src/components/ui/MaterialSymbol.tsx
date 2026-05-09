import { Icon } from "@iconify/react";

function toKebab(raw: string) {
  return raw.replace(/_/g, "-");
}

/**
 * Iconify's `material-symbols` set does not ship `-outline` for every glyph (e.g. `search`,
 * `wifi`, `target`, `alternate-email`). Using a missing id yields an empty SVG.
 * @see https://api.iconify.design/material-symbols.json
 */
const NO_OUTLINE_SUFFIX = new Set([
  "search",
  "wifi",
  "language",
  "alternate-email",
  "code",
  "target",
  "arrow-forward",
  "update",
  "radar",
  "expand-more",
  "flight",
  "stacked-line-chart",
  "arrow-back",
  "close",
  "logout",
  "bar-chart",
  "hourglass-empty",
  "history",
  "block",
  "verified-user",
]);

/**
 * Renders a Material Symbol as SVG via Iconify (reliable vs webfont ligatures,
 * which break when body/sans font stacks win over `Material Symbols Outlined`).
 */
export function MaterialSymbol({
  name,
  className,
  filled = false,
}: {
  name: string;
  className?: string;
  filled?: boolean;
}) {
  const k = toKebab(name);
  const icon =
    filled || NO_OUTLINE_SUFFIX.has(k) ? `material-symbols:${k}` : `material-symbols:${k}-outline`;
  return <Icon icon={icon} className={className} width="1em" height="1em" aria-hidden />;
}
