export const FLOW_SCENARIOS = [
  {
    icon: "shield",
    title: "Validate hardened segments",
    copy: "Map policies, subnets, and trust boundaries against live inventories.",
    accent: "text-primary border-primary/30 bg-primary/5",
  },
  {
    icon: "radar",
    title: "Explore attack hypotheses",
    copy: "Let recon agents widen or narrow hypotheses from a single briefing.",
    accent: "text-tertiary border-tertiary/30 bg-tertiary/5",
  },
  {
    icon: "shopping_cart",
    title: "Test checkout-critical paths",
    copy: "Chase exploitation chains tied to monetization APIs and gateways.",
    accent: "text-error border-error/30 bg-error/10",
  },
  {
    icon: "flight",
    title: "Follow multi-hop pivots",
    copy: "Trace lateral movement narratives like flight paths across hosts.",
    accent: "text-primary border-primary/30 bg-primary/10",
  },
] as const;

export type FeatureBand = {
  kicker: string;
  title: string;
  body: string;
  video: boolean;
  /** When set, overrides default sample CDN clips (served from `/public`). */
  videoSrc?: string;
};

export const FEATURE_BANDS: FeatureBand[] = [
  {
    kicker: "Unified operations",
    title: "All-in-one offensive orchestration",
    body: "Plan, execute, and document across recon, vuln correlation, chaining, and reporting—all from coordinated agents that share telemetry instead of brittle scripts.",
    video: true,
    videoSrc: "/v2.mp4",
  },
  {
    kicker: "Live telemetry",
    title: "API and console in one strategy",
    body: "Correlate raw HTTP chatter with shell transcripts and ticket context. CipherStrike merges signals so analysts never lose the plot mid-engagement.",
    video: false,
  },
  {
    kicker: "Operational truth",
    title: "Evidence your operators can defend",
    body: "Every step keeps raw transcripts, tool output, and artefact references on one timeline—so red-cell leads, reviewers, and blue partners can replay what happened without trust-me screenshots or narrative drift.",
    video: true,
    videoSrc: "/v3.mp4",
  },
];

export const INTEL_CARDS = [
  {
    title: "Compose in natural language",
    body: "Describe intent (“enumerate SMBv1 anonymously, escalate only if…”); agents negotiate the toolchain for you.",
    icon: "edit_note",
  },
  {
    title: "Dangerous payloads, deliberate gates",
    body: "Queue exploit modules but require explicit human approval tokens before payloads leave quarantine.",
    icon: "lock",
  },
  {
    title: "Modular playbooks",
    body: "Package recon blocks, parsers, and post-ex wrappers as reusable meshes that survive stack drift.",
    icon: "stacked_line_chart",
  },
  {
    title: "Dynamic target fabric",
    body: "Import CSV inventories, IaC manifests, or live cloud tags to hydrate scope without rewriting glue code.",
    icon: "cloud_sync",
  },
] as const;

export const FAQ_ITEMS = [
  {
    q: "How does CipherStrike shorten long red-team cycles?",
    a: "Specialized agents own recon, chaining, exploitation, and reporting concurrently. Humans approve escalations while automation keeps proofs and timelines synchronized.",
  },
  {
    q: "Does CipherStrike replace my existing toolchain?",
    a: "No—it orchestrates the binaries your team already trusts. Keep your preferred distros while CipherStrike brokers execution, transcripts, and evidence.",
  },
  {
    q: "Who should operate CipherStrike?",
    a: "Mature offensive security shops, MSSP reds, and product security teams exercising continuous assurance—only inside environments you legally control.",
  },
  {
    q: "Can I restrict autonomous actions?",
    a: "Yes. Configure policy rails, segmented credentials, scoped networks, and per-step confirmations before any impactful payload executes.",
  },
  {
    q: "What does “human-in-the-loop” mean here?",
    a: "Every autonomous fan-out includes review surfaces: plans, payloads, pivots. Operators can veto, annotate, or branch strategies without rewriting automation from scratch.",
  },
] as const;

/** Google's sample CDN clips — replace with CipherStrike-produced media when ready. */
export const SAMPLE_VIDEOS = {
  blaze: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerBlazes.mp4",
  escapes: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ForBiggerEscapes.mp4",
} as const;
