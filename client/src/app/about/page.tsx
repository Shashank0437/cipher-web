import type { Metadata } from "next";
import { MarketingSubpage } from "@/components/layout/MarketingSubpage";

export const metadata: Metadata = {
  title: "About | Vrika",
  description: "Mission, posture, and who Vrika is built for.",
};

export default function AboutPage() {
  return (
    <MarketingSubpage
      title="About Vrika"
      eyebrow="Company"
      lastUpdated="May 8, 2026"
      breadcrumbLabel="Company"
      toc={[
        { href: "#mission", label: "Mission" },
        { href: "#who", label: "Who we serve" },
        { href: "#values", label: "Values" },
        { href: "#contact", label: "Contact" },
      ]}
    >
      <p className="lead-intro text-on-surface">
        Vrika exists so elite security teams can orchestrate aggressive validation programs without drowning in glue code.
        We pair specialized agents with the binaries operators already trust—Metasploit, Nmap, Burp-family workers, custom CLIs—so
        every engagement produces consistent telemetry, human-readable narratives, and evidence suited for executives and
        auditors alike.
      </p>

      <h2 id="mission">Mission</h2>
      <p>
        Speed up authorized offensive security while raising the bar on supervision. Automation should expand coverage, not hide
        recklessness: Vrika bakes policy gates, immutable logs, and operator checkpoints into the fabric of every cluster.
      </p>

      <h2 id="who">Who we serve</h2>
      <ul>
        <li>Internal red teams proving ROI on zero-trust rollouts;</li>
        <li>Product security groups pressure-testing multi-tenant SaaS;</li>
        <li>Consultancies delivering recurring PTaaS with standardized reporting;</li>
        <li>Critical infrastructure researchers operating under strict regulatory frameworks.</li>
      </ul>

      <h2 id="values">Operating values</h2>
      <ul>
        <li>
          <strong>Authorization first</strong>—no scope, no spin-up.
        </li>
        <li>
          <strong>Transparency</strong>—stdout, stderr, hashes, and decision journals ship with every run.
        </li>
        <li>
          <strong>Composable automation</strong>—swap tools, keep orchestration.
        </li>
      </ul>

      <h2 id="contact">Contact</h2>
      <p>
        Media, partnership, or procurement inquiries should route through your Vrika account manager or the contact form
        published on this site once live. For security-sensitive topics, use the Responsible Disclosure channel.
      </p>
    </MarketingSubpage>
  );
}
