import Link from "next/link";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

const BENEFITS = [
  {
    title: "Mesh-native orchestration",
    body: "Specialized agents share telemetry across recon, chaining, and reporting—not brittle one-off scripts.",
  },
  {
    title: "Evidence you can defend",
    body: "Raw transcripts, tool output, and artefacts on one timeline for red leads, reviewers, and blue partners.",
  },
  {
    title: "Human gates before impact",
    body: "Policy rails and explicit approvals before anything irreversible leaves quarantine.",
  },
];

export function AuthMarketingPanel() {
  return (
    <aside className="relative flex min-h-[min(48vh,440px)] flex-col justify-between overflow-hidden border-b border-outline-variant bg-gradient-to-br from-[#f5f2fc] via-[#faf8ff] to-[#eef5f3] px-8 py-10 text-neutral-900 lg:sticky lg:top-0 lg:h-dvh lg:min-h-0 lg:w-[min(100%,480px)] lg:shrink-0 lg:border-b-0 lg:border-r lg:px-12 lg:py-14">
      <div className="pointer-events-none absolute -left-16 top-[-10%] h-[min(70vw,280px)] w-[min(70vw,280px)] rounded-full bg-primary/15 blur-[90px]" />
      <div className="pointer-events-none absolute -bottom-20 -right-10 h-40 w-40 rounded-full bg-tertiary/10 blur-[70px]" />
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(255,255,255,0.7)_0%,transparent_55%)]" />

      <div className="relative">
        <p className="text-[11px] font-bold uppercase tracking-[0.4em] text-primary">CipherStrike</p>
        <h2 className="mt-6 max-w-sm text-3xl font-semibold leading-[1.15] tracking-tight text-neutral-900 lg:text-[2rem]">
          Offensive security, orchestrated.
        </h2>
        <p className="mt-4 max-w-sm text-sm leading-relaxed text-neutral-600">
          One workspace for coordinated agents, auditable evidence, and operator control—built for mature red teams and product
          security programs.
        </p>

        <ul className="mt-10 space-y-6">
          {BENEFITS.map((item) => (
            <li key={item.title} className="flex gap-4">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-white/90 shadow-sm ring-1 ring-outline-variant">
                <MaterialSymbol name="check_circle" filled className="text-lg text-tertiary" />
              </span>
              <div>
                <p className="font-semibold text-neutral-900">{item.title}</p>
                <p className="mt-1 text-sm leading-relaxed text-neutral-600">{item.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="relative mt-12 border-t border-outline-variant/80 pt-8 lg:mt-0">
        <p className="text-[11px] leading-relaxed text-neutral-500">
          Use only in environments you legally control. CipherStrike is for authorized security testing—not unauthorized access.
        </p>
        <Link
          href="/"
          className="mt-6 inline-flex items-center gap-2 text-sm font-medium text-primary transition-colors hover:text-primary-dim"
        >
          <MaterialSymbol name="arrow_back" className="text-base" />
          Back to site
        </Link>
      </div>
    </aside>
  );
}
