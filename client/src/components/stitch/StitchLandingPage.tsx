import { Icon } from "@iconify/react";
import Link from "next/link";
import { FEATURE_BANDS, FAQ_ITEMS, FLOW_SCENARIOS, INTEL_CARDS, SAMPLE_VIDEOS } from "@/components/landing/landing-data";
import { LandingFaq } from "@/components/landing/LandingFaq";
import { LandingNav } from "@/components/landing/LandingNav";
import { DemoVideo } from "@/components/stitch/DemoVideo";
import { LandingAuthLink, LandingHeroPrimaryCta } from "@/components/stitch/LandingAuthCta";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { FOOTER_PLATFORM_LINKS, FOOTER_RESOURCE_LINKS } from "@/lib/coming-soon-routes";

/** Layout + narrative inspired by https://www.testmuai.com/kane-ai/ — CipherStrike branded, original copy. */
const HERO_TEXTURE =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuBDVCqaAwavljXHCv6iy-HTkq_EFklP46KElPDexQUolB-7JQg-qUCDs1HGgESCJT5z4J-Iz3gcqrgYcCYHAEPP7Td8Yl7ItHXCYtWDp3gLVGn_yySXd245kX_mLVsof3x4yc8IEdzMUQ-C34-ugoq-eg8UhgICh1_CIglXcVDHRvz0vuCGaZTHvnJI7El2ZZ6Tc_BrKlzJeF2qB6K36Ufa0eKzfI2lw0_FD5NclVXkbkw0ZDWuKo-3VIb0UA_c3AfW-cacCE3uoWI";

const BENTO_IMG =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuBD9_3nqUvwaNm5hsc9ZxCunIpk2Fcm0OoPO44ySHM011EGqMJNbZ-gNXtk_nQ8LUDn_Ng78lYJqXGFTrtsNe6ckFuQmqGd7zhPnNSQXb6d1p7rf4kAva4d1__IxiCizP3qUCDDSUTMXxfKbODLAiaxjCLKjugojf2kfxQLiQU3bcbeQ562Ccw_6E0KbOKWlCI1A3DE-besDEJPTAGmsbmjr1SRIAVQ_CoJJGlxMA9GXAUpGG_wS112kUWOL6p-XXwIeFJjd2WHFqA";

const TOOL_CHIPS: { icon: string; label: string }[] = [
  { icon: "search", label: "NMAP" },
  { icon: "database", label: "SQLMAP" },
  { icon: "shield", label: "METASPLOIT" },
  { icon: "wifi", label: "AIRCRACK-NG" },
  { icon: "key", label: "JOHN" },
  { icon: "language", label: "BURPSUITE" },
  { icon: "lan", label: "WIRESHARK" },
];

const FOOTER_COPYRIGHT = "© 2026 CipherStrike. All rights reserved.";

const FOOTER_LEGAL_LINKS = [
  { href: "/terms-of-use", label: "Terms of Use" },
  { href: "/privacy-policy", label: "Privacy Policy" },
  { href: "/security-disclosure", label: "Security Disclosure" },
  { href: "/responsible-disclosure", label: "Responsible Disclosure" },
] as const;

const FOOTER_SOCIAL_DECOR: { icon: string; label: string }[] = [
  { icon: "simple-icons:x", label: "X" },
  { icon: "simple-icons:linkedin", label: "LinkedIn" },
  { icon: "simple-icons:instagram", label: "Instagram" },
  { icon: "simple-icons:youtube", label: "YouTube" },
  { icon: "simple-icons:github", label: "GitHub" },
];

function ToolMarqueeRow({ rowKey }: { rowKey: string }) {
  return (
    <>
      {TOOL_CHIPS.map((t) => (
        <div
          key={`${rowKey}-${t.label}`}
          className="flex shrink-0 cursor-default items-center gap-3 rounded-full border border-outline-variant bg-surface px-6 py-3 transition-colors hover:border-primary/50"
        >
          <MaterialSymbol name={t.icon} className="shrink-0 text-xl text-primary" />
          <span className="font-bold tracking-tighter">{t.label}</span>
        </div>
      ))}
    </>
  );
}

export function StitchLandingPage() {
  return (
    <div className="bg-background font-sans text-on-background antialiased selection:bg-primary selection:text-on-primary">
      <LandingNav />

      <main>
        {/* Kane-style immersive hero */}
        <section className="relative isolate overflow-hidden bg-[#05030c] pb-20 pt-28 text-white md:min-h-[min(960px,100dvh)] md:pb-28">
          <div className="landing-hero-orb pointer-events-none absolute -left-48 top-[-10%] size-[min(120vw,620px)] rounded-full bg-[#6d28d9]/55 blur-[140px]" />
          <div className="landing-hero-orb landing-hero-orb-delay pointer-events-none absolute -right-40 top-1/3 size-[520px] rounded-full bg-[#22d3ee]/25 blur-[130px]" />
          <div className="landing-hero-mesh pointer-events-none absolute inset-0 opacity-[0.12]" />

          <div
            className="pointer-events-none absolute inset-0 z-0 opacity-20"
            style={{ backgroundImage: `url('${HERO_TEXTURE}')`, backgroundSize: "cover" }}
          />

          <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-14 px-6 lg:grid-cols-2 lg:gap-12">
            <div className="space-y-8">
              <p className="text-xs font-bold uppercase tracking-[0.35em] text-white/60">GenAI-native offensive fabric</p>
              <h1 className="text-5xl font-extrabold leading-[1.05] tracking-tight md:text-6xl lg:text-7xl">
                Plan, chain, and evolve <span className="text-[#c4b5fd]">autonomous red ops</span>
              </h1>
              <p className="max-w-xl text-lg leading-relaxed text-white/75 md:text-xl">
                Twelve specialized agents orchestrate 147+ security tools using natural language directives. Move at the speed of thought—only
                where you are authorized to operate.
              </p>
              <div className="flex flex-wrap gap-4">
                <LandingHeroPrimaryCta className="inline-flex items-center justify-center rounded-full bg-white px-9 py-4 text-base font-bold text-[#160b2b] shadow-xl shadow-black/30 transition hover:bg-white/90" />
                <a
                  href="#demo"
                  className="inline-flex items-center justify-center rounded-full border border-white/40 bg-white/5 px-9 py-4 text-base font-bold text-white backdrop-blur-sm transition hover:bg-white/10"
                >
                  Watch the loop
                </a>
              </div>
              <div className="flex flex-wrap gap-6 pt-2 text-sm text-white/55">
                <div>
                  <p className="text-2xl font-black text-white">147+</p>
                  <p>native tool hooks</p>
                </div>
                <div className="hidden h-12 w-px bg-white/15 sm:block" />
                <div>
                  <p className="text-2xl font-black text-white">12</p>
                  <p>agent roles</p>
                </div>
                <div className="hidden h-12 w-px bg-white/15 sm:block" />
                <div>
                  <p className="text-2xl font-black text-white">24/7</p>
                  <p>orchestrated telemetry</p>
                </div>
              </div>
            </div>

            <div className="group relative">
              <div className="absolute -inset-1 rounded-2xl bg-gradient-to-r from-violet-400/30 to-cyan-400/20 opacity-60 blur-2xl transition duration-1000 group-hover:opacity-95" />
              <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-[#0f0a1f]/90 shadow-2xl backdrop-blur-xl">
                <div className="flex items-center justify-between border-b border-white/10 bg-white/5 px-4 py-2.5">
                  <div className="flex gap-1.5">
                    <div className="h-3 w-3 rounded-full bg-red-400/80" />
                    <div className="h-3 w-3 rounded-full bg-amber-400/70" />
                    <div className="h-3 w-3 rounded-full bg-emerald-400/70" />
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-white/40">cipherstrike-v2.0 // mesh</span>
                </div>
                <div className="min-h-[320px] space-y-4 p-6 font-mono text-sm text-white/90">
                  <div className="flex flex-wrap gap-2">
                    <span className="text-[#c4b5fd]">root@cipherstrike:~$</span>
                    <span>orchestrate --cluster=shadow --scope=prod-sim</span>
                  </div>
                  <div className="text-emerald-400">[OK] Policy mesh synchronized. Human gates armed.</div>
                  <div className="border-l border-white/15 pl-4 text-sm text-white/50">
                    [recon] surveying service graph…
                    <br />
                    [chain] correlating CVE-2024-XXXX with live listeners
                    <br />
                    [humint] awaiting operator approval ▸ payload queue (2)
                  </div>
                  <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/5 p-4">
                    <div className="flex items-center gap-3">
                      <MaterialSymbol name="analytics" className="text-[#c4b5fd] text-xl" />
                      <span className="text-xs text-white/80">Strike confidence</span>
                    </div>
                    <div className="h-2 w-36 overflow-hidden rounded-full bg-white/10">
                      <div className="h-full w-[91%] rounded-full bg-gradient-to-r from-[#8b5cf6] to-[#22d3ee]" />
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Flow cards — Kane scenario strip */}
        <section id="pulse" className="border-b border-outline-variant bg-surface-container-low py-14">
          <div className="mx-auto max-w-6xl px-6">
            <p className="mb-3 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-on-surface-variant">Operator loops</p>
            <h2 className="mx-auto mb-10 max-w-3xl text-center text-3xl font-bold tracking-tight text-on-surface md:text-4xl">
              Every engagement starts as a storyline—agents keep it coherent.
            </h2>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {FLOW_SCENARIOS.map((s) => (
                <div
                  key={s.title}
                  className={`flex flex-col rounded-2xl border p-6 shadow-sm backdrop-blur-sm ${s.accent}`}
                >
                  <div className="mb-4 inline-flex size-12 items-center justify-center rounded-xl border bg-white/60 dark:bg-black/10">
                    <MaterialSymbol name={s.icon} className="text-3xl" />
                  </div>
                  <h3 className="mb-2 text-lg font-bold text-on-surface">{s.title}</h3>
                  <p className="text-sm leading-relaxed text-on-surface-variant">{s.copy}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="overflow-hidden border-b border-outline-variant bg-background py-12">
          <div className="mx-auto max-w-6xl px-6">
            <p className="mb-8 text-center text-[10px] font-bold uppercase tracking-[0.3em] text-on-surface-variant">
              Trusted by modern security operations
            </p>
            <div className="flex flex-wrap items-center justify-center gap-x-14 gap-y-8 grayscale opacity-55 transition-all hover:grayscale-0 hover:opacity-100">
              {[
                { icon: "verified_user", name: "SENTINEL" },
                { icon: "token", name: "VOIDSEC" },
                { icon: "hive", name: "CIPHERSTRIKE" },
                { icon: "layers", name: "PHANTOM.IO" },
                { icon: "radar", name: "NETSTRIKE" },
              ].map((b) => (
                <div key={b.name} className="flex items-center gap-2">
                  <MaterialSymbol name={b.icon} className="text-3xl text-on-surface" />
                  <span className="text-xl font-black tracking-tighter text-on-surface">{b.name}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Demo + video */}
        <section id="demo" className="mx-auto max-w-6xl scroll-mt-28 px-6 py-24">
          <div className="grid items-center gap-12 lg:grid-cols-2">
            <div className="order-2 space-y-6 lg:order-1">
              <p className="text-xs font-bold uppercase tracking-[0.3em] text-primary">Product tour</p>
              <h2 className="text-3xl font-bold tracking-tight text-on-surface md:text-4xl">See the mesh react in real time.</h2>
              <p className="text-lg text-on-surface-variant">
                Drop a goal in plain language, watch recon fan out, and keep humans in the loop before anything irreversible fires.
              </p>
              <ul className="space-y-3 text-sm text-on-surface-variant">
                <li className="flex gap-2">
                  <MaterialSymbol name="check_circle" className="mt-0.5 shrink-0 text-tertiary text-xl" />
                  Live transcripts + synchronized timelines
                </li>
                <li className="flex gap-2">
                  <MaterialSymbol name="check_circle" className="mt-0.5 shrink-0 text-tertiary text-xl" />
                  Binary execution—not toy wrappers
                </li>
              </ul>
            </div>
            <div className="order-1 lg:order-2">
              <DemoVideo src="/v1.mp4" />
            </div>
          </div>
        </section>

        {/* Alternating feature bands */}
        {FEATURE_BANDS.map((band, i) => {
          const defaultVideo = i % 2 === 0 ? SAMPLE_VIDEOS.blaze : SAMPLE_VIDEOS.escapes;
          const videoSrc = band.videoSrc ?? defaultVideo;
          const reverse = i % 2 === 1;
          return (
            <section
              key={band.title}
              className={`border-y border-outline-variant py-20 ${i % 2 === 0 ? "bg-surface-container-low" : "bg-background"}`}
            >
              <div className="mx-auto grid max-w-6xl items-center gap-12 px-6 md:grid-cols-2">
                <div className={reverse ? "md:order-2" : ""}>
                  <p className="text-xs font-bold uppercase tracking-[0.3em] text-primary">{band.kicker}</p>
                  <h3 className="mt-3 text-3xl font-bold text-on-surface md:text-4xl">{band.title}</h3>
                  <p className="mt-4 text-lg text-on-surface-variant">{band.body}</p>
                </div>
                <div className={reverse ? "md:order-1" : ""}>
                  {band.video ? (
                    <DemoVideo src={videoSrc} />
                  ) : (
                    <div className="relative aspect-video overflow-hidden rounded-3xl border border-outline-variant bg-surface-container shadow-xl">
                      {/* eslint-disable-next-line @next/next/no-img-element -- remote Stitch asset */}
                      <img src={BENTO_IMG} alt="" className="h-full w-full object-cover opacity-60" />
                      <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/50 to-transparent p-8 text-center">
                        <p className="text-lg font-semibold text-white drop-shadow-lg">
                          Glue HTTP transcripts, PCAP hints, and shell scrollback into one operator timeline.
                        </p>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </section>
          );
        })}

        {/* Bento */}
        <section className="mx-auto max-w-7xl px-6 py-24">
          <div className="mb-14 text-center">
            <p className="mb-3 text-xs font-bold uppercase tracking-[0.28em] text-primary">Unified mesh</p>
            <h2 className="text-3xl font-bold text-on-surface md:text-5xl">
              Precision-engineered <span className="text-primary">offensive intelligence</span>
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-lg text-on-surface-variant">
              One canvas for elites who refuse to babysit brittle scripts—built for sanctioned environments only.
            </p>
          </div>

          <div className="grid auto-rows-[minmax(260px,auto)] grid-cols-1 gap-4 md:grid-cols-12">
            <div className="flex flex-col justify-between rounded-2xl border border-outline-variant bg-surface-container p-8 md:col-span-8 md:row-span-2">
              <div>
                <div className="mb-6 inline-flex size-14 items-center justify-center rounded-xl border border-primary/30 bg-primary/10">
                  <MaterialSymbol name="hub" filled className="text-3xl text-primary" />
                </div>
                <h3 className="mb-3 text-2xl font-bold text-on-surface">Mesh-native architecture</h3>
                <p className="max-w-xl text-lg text-on-surface-variant">
                  Specialized runners cover reconnaissance, chaining, exploitation, and reporting—with shared memories so plans do not drift
                  mid-run.
                </p>
              </div>
              <div className="relative mt-8 aspect-video w-full overflow-hidden rounded-2xl border border-outline-variant">
                {/* eslint-disable-next-line @next/next/no-img-element -- remote asset */}
                <img src={BENTO_IMG} alt="" className="absolute inset-0 h-full w-full object-cover opacity-55" />
                <div className="absolute inset-0 flex items-center justify-center bg-gradient-to-t from-black/40 to-transparent">
                  <div className="grid grid-cols-3 gap-6">
                    {[
                      { c: "border-primary text-primary", i: "visibility" },
                      { c: "border-tertiary text-tertiary", i: "bolt" },
                      { c: "border-error text-error", i: "target" },
                    ].map((x) => (
                      <div
                        key={x.i}
                        className={`flex h-14 w-14 items-center justify-center rounded-full border bg-white/85 backdrop-blur ${x.c} md:h-16 md:w-16`}
                      >
                        <MaterialSymbol name={x.i} className="text-2xl" />
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>

            <div className="flex flex-col justify-center rounded-2xl border border-outline-variant bg-surface-container p-8 text-center md:col-span-4 md:row-span-2">
              <div className="mx-auto mb-6 inline-flex size-20 items-center justify-center rounded-full border border-tertiary/35 bg-tertiary/10">
                <MaterialSymbol name="psychology" filled className="text-4xl text-tertiary" />
              </div>
              <h3 className="mb-3 text-2xl font-bold text-on-surface">Humans veto superpowers</h3>
              <p className="text-lg text-on-surface-variant">
                Pause any branch, annotate intent, inject new objectives—without rebooting clusters.
              </p>
              <div className="mt-10 space-y-3 text-left">
                {[
                  { t: "Cluster plan", s: "Pending approval", sc: "text-tertiary bg-tertiary/10" },
                  { t: "Exfil payloads", s: "Gated", sc: "text-error bg-error/10" },
                  { t: "CVE dossier", s: "Ready", sc: "text-tertiary bg-tertiary/10" },
                ].map((r) => (
                  <div
                    key={r.t}
                    className="flex h-11 items-center justify-between rounded-xl border border-outline-variant bg-surface-container-lowest px-4"
                  >
                    <span className="font-mono text-xs text-on-surface">{r.t}</span>
                    <span className={`rounded px-2 py-0.5 text-[10px] font-bold uppercase ${r.sc}`}>{r.s}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-col gap-8 rounded-2xl border border-outline-variant bg-surface-container p-8 md:col-span-12 md:flex-row md:items-center">
              <div className="flex-1">
                <div className="mb-3 inline-flex items-center gap-2 text-tertiary">
                  <MaterialSymbol name="update" className="text-xl" />
                  <span className="text-xs font-bold uppercase tracking-wider">Streaming intel</span>
                </div>
                <h3 className="text-2xl font-bold text-on-surface">CVE correlation on arrival</h3>
                <p className="mt-2 max-w-xl text-on-surface-variant">
                  Fuse scanner output with vendor advisories milliseconds after ingestion—prioritize what operators should read first.
                </p>
              </div>
              <div className="flex-1 rounded-2xl border border-outline-variant bg-surface-container-lowest p-4 font-mono text-[11px] text-tertiary">
                <div className="animate-pulse">Hydrating telemetry…</div>
                <div className="mt-2 text-on-surface-variant">&gt; dataset: ingress-prod-East</div>
                <div className="mt-2 rounded-xl border border-tertiary/25 bg-tertiary/5 p-3">
                  <div className="flex justify-between font-bold text-on-surface">
                    <span>CVE-2024-XXXX</span>
                    <span className="text-error">SEVERITY 9.8</span>
                  </div>
                  <div className="mt-1 text-on-surface-variant">Kernel netfilter misuse — chaining candidates: 4</div>
                  <div className="mt-2 text-primary underline decoration-dotted">Queue mitigations playbook</div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Modular intel */}
        <section id="intel" className="scroll-mt-28 border-y border-outline-variant bg-surface-container-low py-24">
          <div className="mx-auto max-w-6xl px-6">
            <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-primary">Composable muscle</p>
            <h2 className="mt-3 text-center text-3xl font-bold text-on-surface md:text-4xl">Intelligent modules, zero busywork glue.</h2>
            <p className="mx-auto mt-3 max-w-2xl text-center text-lg text-on-surface-variant">
              Opinionated primitives that snap together like Kane-style blocks—adapted for offensive operations.
            </p>
            <div className="mt-14 grid gap-5 sm:grid-cols-2">
              {INTEL_CARDS.map((c) => (
                <article key={c.title} className="rounded-2xl border border-outline-variant bg-surface-container-lowest p-8 shadow-sm">
                  <MaterialSymbol name={c.icon} className="mb-4 text-3xl text-primary" />
                  <h3 className="mb-2 text-xl font-bold text-on-surface">{c.title}</h3>
                  <p className="text-on-surface-variant">{c.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Arsenal marquee */}
        <section id="arsenal" className="scroll-mt-28 border-y border-outline-variant bg-background py-24">
          <div className="mx-auto mb-12 max-w-6xl px-6 text-center">
            <h2 className="text-3xl font-bold text-on-surface md:text-4xl">
              Weaponized <span className="text-primary">toolchain</span>
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-on-surface-variant">
              Transparent orchestration keeps hashes, stdout, and timelines aligned for auditors—not black boxes.
            </p>
          </div>
          <div className="stitch-marquee-container relative py-4">
            <div className="absolute inset-y-0 left-0 z-10 w-32 bg-gradient-to-r from-background to-transparent" />
            <div className="absolute inset-y-0 right-0 z-10 w-32 bg-gradient-to-l from-background to-transparent" />
            <div className="stitch-marquee-content gap-12">
              <ToolMarqueeRow rowKey="a" />
              <ToolMarqueeRow rowKey="b" />
            </div>
          </div>
          <div className="mt-12 flex justify-center">
            <LandingAuthLink
              href="/login"
              signedInHref="/tools"
              className="inline-flex items-center gap-2 font-bold text-primary hover:underline"
            >
              Inspect the arsenal
              <MaterialSymbol name="arrow_forward" className="inline text-xl" />
            </LandingAuthLink>
          </div>
        </section>

        {/* FAQ */}
        <section id="faq" className="scroll-mt-28 px-6 py-24">
          <p className="text-center text-xs font-bold uppercase tracking-[0.3em] text-primary">FAQ</p>
          <h2 className="mt-3 text-center text-3xl font-bold text-on-surface md:text-4xl">Everything your security council will ask.</h2>
          <p className="mx-auto mt-3 max-w-2xl text-center text-on-surface-variant">
            Transparent answers—not marketing vapor. Customize this grid with your compliance story as it hardens.
          </p>
          <div className="mx-auto mt-12 max-w-3xl">
            <LandingFaq items={FAQ_ITEMS} />
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="border-t border-outline-variant bg-surface-container-lowest px-6 pb-14 pt-20">
        <div className="mx-auto max-w-7xl">
          <div className="mb-16 grid grid-cols-2 gap-12 md:grid-cols-4 lg:grid-cols-5">
            <div className="col-span-2">
              <div className="mb-6 flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary">
                  <MaterialSymbol name="security" filled className="text-on-primary text-2xl" />
                </div>
                <span className="text-2xl font-black tracking-tighter text-on-surface uppercase">CipherStrike</span>
              </div>
              <p className="max-w-xs leading-relaxed text-on-surface-variant">
                Autonomous offensive security with adult supervision—the way modern enterprises demand.
              </p>
              <div className="mt-8 flex gap-4">
                {["alternate_email", "groups", "code"].map((ic) => (
                  <span
                    key={ic}
                    className="flex h-10 w-10 cursor-default items-center justify-center rounded-lg border border-outline-variant text-on-surface-variant"
                  >
                    <MaterialSymbol name={ic} className="text-xl" />
                  </span>
                ))}
              </div>
            </div>
            <div className="space-y-4">
              <h4 className="text-xs font-bold tracking-widest text-on-surface uppercase">Platform</h4>
              <ul className="space-y-2 text-sm text-on-surface-variant">
                {FOOTER_PLATFORM_LINKS.map(({ href, label }) => (
                  <li key={href}>
                    <Link href={href} className="transition-colors hover:text-primary">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-xs font-bold tracking-widest text-on-surface uppercase">Resources</h4>
              <ul className="space-y-2 text-sm text-on-surface-variant">
                {FOOTER_RESOURCE_LINKS.map(({ href, label }) => (
                  <li key={href}>
                    <Link href={href} className="transition-colors hover:text-primary">
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-4">
              <h4 className="text-xs font-bold tracking-widest text-on-surface uppercase">Company</h4>
              <ul className="space-y-2 text-sm text-on-surface-variant">
                <li>
                  <Link href="/about" className="transition-colors hover:text-primary">
                    About
                  </Link>
                </li>
                <li>
                  <Link href="/terms-of-use" className="transition-colors hover:text-primary">
                    Legal
                  </Link>
                </li>
                <li>
                  <Link href="/privacy-policy" className="transition-colors hover:text-primary">
                    Privacy
                  </Link>
                </li>
              </ul>
            </div>
          </div>
          <div className="flex flex-col gap-6 border-t border-outline-variant pt-8 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 flex-wrap items-center text-xs leading-relaxed text-on-surface-variant">
              <span>{FOOTER_COPYRIGHT}</span>
              {FOOTER_LEGAL_LINKS.map((item) => (
                <span key={item.href} className="inline-flex items-center">
                  <span className="mx-2 select-none text-outline-variant" aria-hidden>
                    |
                  </span>
                  <Link href={item.href} className="transition-colors hover:text-primary hover:underline">
                    {item.label}
                  </Link>
                </span>
              ))}
            </div>
            <div className="flex shrink-0 items-center gap-5 text-on-surface-variant">
              {FOOTER_SOCIAL_DECOR.map(({ icon, label }) => (
                <span key={label} className="inline-flex opacity-60" aria-label={label} title={label}>
                  <Icon icon={icon} className="size-5" aria-hidden />
                </span>
              ))}
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
