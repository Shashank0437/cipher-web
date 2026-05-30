import type { Metadata } from "next";
import { MarketingSubpage } from "@/components/layout/MarketingSubpage";

export const metadata: Metadata = {
  title: "Privacy Policy | Vrika",
  description: "How Vrika handles personal and operational information.",
};

export default function PrivacyPolicyPage() {
  return (
    <MarketingSubpage
      title="Privacy Policy"
      lastUpdated="May 8, 2026"
      toc={[
        { href: "#who", label: "Who processes data?" },
        { href: "#categories", label: "Categories" },
        { href: "#purposes", label: "Purposes & bases" },
        { href: "#processors", label: "Processors & transfers" },
        { href: "#retention", label: "Retention" },
        { href: "#rights", label: "Your rights" },
        { href: "#children", label: "Children" },
        { href: "#changes", label: "Updates" },
      ]}
    >
      <p>
        This Privacy Policy explains how Vrika collects, processes, transfers, stores, or deletes (&quot;processes&quot;)
        information when you use our websites, authentications portals, SaaS workspaces, binaries, integrations, telemetry
        channels, support channels, sales interactions, marketing forms, trials, proofs-of-concept, or training assets
        (&quot;Services&quot;). It complements enterprise Data Processing Agreements where those exist.
      </p>

      <h2 id="who">Who processes data?</h2>
      <p>
        The entity identified in your invoice, Terms of Subscription, pilot agreement, master services agreement—or, if none
        applies, Vrika Platforms Ltd. branded as Vrika—is the processor or controller depending on jurisdiction and
        your agreement.
      </p>

      <h2 id="categories">Categories of information</h2>
      <ul>
        <li>
          <strong>Identifiers</strong> such as corporate email, SSO subject IDs, pseudonymous device IDs linked to workspaces.
        </li>
        <li>
          <strong>Usage diagnostics</strong> including auth logs, timestamps, coarse geolocation inferred from egress IP blocks,
          error traces, replay segments you opt into submit.
        </li>
        <li>
          <strong>Operational security artefacts</strong> necessary to fulfil engagements—notably inventories, PCAP metadata,
          credentials reference tokens (excluding raw secrets wherever vault integrations exist), command transcripts, ticketing
          links, remediation notes.
        </li>
      </ul>
      <p>
        Sensitive personal data unrelated to sanctioned testing should never be pasted into tooling; sanitization tooling is still
        your responsibility.
      </p>

      <h2 id="purposes">Purposes &amp; legal bases</h2>
      <ul>
        <li>Delivering contractual features (contract performance);</li>
        <li>Security monitoring, anomaly detection (legitimate interests, balanced vs. necessity);</li>
        <li>Legal compliance obligations (court orders after validation);</li>
        <li>Communications whose consent banners you affirm (marketing unsubscribes honored promptly).</li>
      </ul>

      <h2 id="processors">Processors &amp; onward transfers</h2>
      <p>
        Vrika leverages sub-processors for hosting, alerting, ticketing sync, SSO, transactional email. Current inventory is
        available on request and updated periodically. Customers may object to substitutions where contractually stipulated.
      </p>
      <p>
        International transfers leverage Standard Contractual Clauses plus supplementary measures where mandated by supervisory
        authorities.
      </p>

      <h2 id="retention">Retention</h2>
      <p>
        Enterprise tenants define retention horizons for engagement bundles. Otherwise default rolling retention trims diagnostic
        buffers after 90 days except security incident evidence held longer if investigation requires. Backups roll off on
        staggered cycles.
      </p>

      <h2 id="rights">Your rights</h2>
      <p>
        Depending on region you may request access, rectification, erasure, restriction, portability, objection, or explanation of
        automated decisions. Enterprise administrators may action many requests through admin consoles; individuals may email a
        privacy desk alias once published.
      </p>

      <h2 id="children">Children</h2>
      <p>
        Vrika does not knowingly process information from children under 16 for consumer purposes—our offerings target
        professional security practitioners.
      </p>

      <h2 id="changes">Updates</h2>
      <p>
        Vrika publishes revision dates atop this Policy. Continuing use constitutes acknowledgment except where regulators
        require explicit consent for newly introduced processing.
      </p>
    </MarketingSubpage>
  );
}
