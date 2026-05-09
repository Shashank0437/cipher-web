/** Footer + static generation for `/coming-soon/[slug]`. */

export type ComingSoonSlug =
  | "mesh-orchestration"
  | "tool-integration"
  | "evidence-fabric"
  | "policy-gates"
  | "documentation"
  | "support"
  | "security-research"
  | "api-surface"
  | "community";

export const COMING_SOON_PAGES: Record<
  ComingSoonSlug,
  { title: string; teaser: string; highlights: string[]; category: "Platform" | "Resources" }
> = {
  "mesh-orchestration": {
    category: "Platform",
    title: "Mesh orchestration",
    teaser:
      "Coordinate agent clusters, policy gates, and execution lanes from one mesh—planned telemetry sharing, backoff, and human checkpoints built in.",
    highlights: ["Multi-agent run graphs", "Scope-aware concurrency", "Live health + queue depth"],
  },
  "tool-integration": {
    category: "Platform",
    title: "Tool integration",
    teaser:
      "Bring the binaries your team trusts—commercial, open-source, or internal builds—with version pinning, attestations, and execution sandboxes suited to reds.",
    highlights: ["Hash-locked payloads", "Credential brokering", "Stdout/stderr as first-class signals"],
  },
  "evidence-fabric": {
    category: "Platform",
    title: "Evidence fabric",
    teaser:
      "Immutable timelines tying transcripts, artefacts, and tickets together so engagements stay defensible across review and tabletops.",
    highlights: ["Chain-friendly exports", "Replay-friendly bundles", "Tenant-scoped retention"],
  },
  "policy-gates": {
    category: "Platform",
    title: "Policy gates",
    teaser:
      "Enforce approvals, egress rules, credential tiers, and kill switches before payloads leave quarantine zones—built for messy real-world engagements.",
    highlights: ["Per-step confirmations", "Blast-radius tags", "Audit-grade decision logs"],
  },
  documentation: {
    category: "Resources",
    title: "Documentation",
    teaser:
      "Deep-dive guides, architecture notes, deployment patterns, and safe defaults—we are writing these for practitioners, not fluff readers.",
    highlights: ["Runbooks & examples", "Reference CLI / API shape", "Hardening checklists"],
  },
  support: {
    category: "Resources",
    title: "Support",
    teaser:
      "Human support channels, SLA guidance, and escalation paths for CipherStrike workspaces—opening soon as we finalize partner coverage.",
    highlights: ["Priority channels", "Runbook-backed triage", "Tenant-scoped ticketing"],
  },
  "security-research": {
    category: "Resources",
    title: "Security research",
    teaser:
      "Notes from our labs on chaining techniques, toolchain hazards, responsible automation, and coordinated disclosure—we ship evidence, not vibes.",
    highlights: ["Advisories index", "Repro snippets", "Disclosure timelines"],
  },
  "api-surface": {
    category: "Resources",
    title: "API surface",
    teaser:
      "Programmatic hooks for workspaces, artefacts, approvals, and webhooks—ideal for tying CipherStrike into your existing SOAR, CI, or custom panels.",
    highlights: ["Versioned schemas", "Idempotent workflows", "Webhooks & streaming"],
  },
  community: {
    category: "Resources",
    title: "Community",
    teaser:
      "Where operators swap playbooks responsibly, within clear rules—no irresponsible exploit trading, focused on sanctioned learning and tooling craft.",
    highlights: ["Forum & office hours", "Partner integrations", "Champion playbook library"],
  },
};

export const COMING_SOON_SLUGS = Object.keys(COMING_SOON_PAGES) as ComingSoonSlug[];

export const FOOTER_PLATFORM_LINKS = [
  { href: "/coming-soon/mesh-orchestration" as const, label: "Mesh orchestration" },
  { href: "/coming-soon/tool-integration" as const, label: "Tool integration" },
  { href: "/coming-soon/evidence-fabric" as const, label: "Evidence fabric" },
  { href: "/coming-soon/policy-gates" as const, label: "Policy gates" },
] as const;

export const FOOTER_RESOURCE_LINKS = [
  { href: "/coming-soon/documentation" as const, label: "Documentation" },
  { href: "/coming-soon/security-research" as const, label: "Security research" },
  { href: "/coming-soon/api-surface" as const, label: "API surface" },
  { href: "/coming-soon/community" as const, label: "Community" },
] as const;

/** Query `back=dashboard` from app shell, or `return` with a whitelisted path only. */
export const COMING_SOON_BACK_QUERY = "back" as const;
export const COMING_SOON_RETURN_QUERY = "return" as const;

const DASHBOARD_BACK_VALUE = "dashboard" as const;

export type ComingSoonBackNav = {
  href: "/" | "/dashboard";
  label: "Back home" | "Back to dashboard";
};

function firstSearchParam(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/** Returns `/` or `/dashboard` when input is a safe same-origin path, else null. */
function parseWhitelistedReturnPath(raw: string): "/" | "/dashboard" | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw.trim());
  } catch {
    return null;
  }
  if (decoded.length > 2048) return null;
  if (/^[a-zA-Z][\w+.-]*:/.test(decoded)) return null;
  if (decoded.startsWith("//")) return null;
  let path = decoded;
  const q = path.indexOf("?");
  if (q !== -1) path = path.slice(0, q);
  const h = path.indexOf("#");
  if (h !== -1) path = path.slice(0, h);
  if (!path.startsWith("/")) return null;
  if (path.includes("..")) return null;
  const parts = path.split("/").filter(Boolean);
  const normalized = parts.length === 0 ? "/" : `/${parts.join("/")}`;
  if (normalized === "/dashboard" || normalized === "/") return normalized;
  return null;
}

export function resolveComingSoonBackNav(
  searchParams: Record<string, string | string[] | undefined>,
): ComingSoonBackNav {
  const ret = firstSearchParam(searchParams[COMING_SOON_RETURN_QUERY]);
  if (ret !== undefined) {
    const p = parseWhitelistedReturnPath(ret);
    if (p === "/dashboard") return { href: "/dashboard", label: "Back to dashboard" };
    if (p === "/") return { href: "/", label: "Back home" };
  }
  const back = firstSearchParam(searchParams[COMING_SOON_BACK_QUERY]);
  if (back === DASHBOARD_BACK_VALUE) return { href: "/dashboard", label: "Back to dashboard" };
  return { href: "/", label: "Back home" };
}

/** Use on `/coming-soon/*` links from the authenticated dashboard shell. */
export const COMING_SOON_FROM_DASHBOARD_QUERY = `${COMING_SOON_BACK_QUERY}=${DASHBOARD_BACK_VALUE}` as const;
