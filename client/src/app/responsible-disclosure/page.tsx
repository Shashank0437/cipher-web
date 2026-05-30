import type { Metadata } from "next";
import { MarketingSubpage } from "@/components/layout/MarketingSubpage";

export const metadata: Metadata = {
  title: "Responsible Disclosure | Vrika",
  description: "How to report security vulnerabilities in Vrika products.",
};

export default function ResponsibleDisclosurePage() {
  return (
    <MarketingSubpage
      title="Responsible Disclosure Program"
      lastUpdated="May 8, 2026"
      toc={[
        { href: "#scope", label: "Scope" },
        { href: "#how", label: "How to report" },
        { href: "#rules", label: "Reporter expectations" },
        { href: "#thanks", label: "Recognition" },
        { href: "#safe-harbor", label: "Safe harbor" },
      ]}
    >
      <p>
        Vrika welcomes coordinated disclosure of vulnerabilities affecting our production services, downloadable clients,
        official SDKs, or managed agent images. We commit to working in good faith with reporters who follow the guidelines
        below.
      </p>

      <h2 id="scope">Scope</h2>
      <p>In scope examples:</p>
      <ul>
        <li>Authentication bypass, privilege escalation, or cross-tenant data exposure in hosted Vrika;</li>
        <li>Remote code execution in default agent sandboxes supplied by Vrika;</li>
        <li>Cryptographic failures undermining tenant isolation or secret handling.</li>
      </ul>
      <p>Out of scope examples:</p>
      <ul>
        <li>Social engineering of individual employees without demonstrated product impact;</li>
        <li>Physical attacks, spam, denial-of-service requiring massive traffic without prior coordination;</li>
        <li>Third-party tools you inject yourself unless the defect is in Vrika&apos;s integration glue exclusively;</li>
        <li>Issues already published or fixed in the latest release channel.</li>
      </ul>

      <h2 id="how">How to report</h2>
      <p>
        Use the encrypted reporting channel documented in your customer trust pack or Vrika&apos;s published security.txt
        (once live). Provide reproducible steps, affected component versions, proof-of-concept artifacts, potential impact if
        known, and your preferred attribution name. Encrypt sensitive attachments using the rotating PGP key published on our trust
        center.
      </p>

      <h2 id="rules">Reporter expectations</h2>
      <ul>
        <li>Do not exploit beyond minimal demonstration proving impact;</li>
        <li>Do not copy, tamper with, destroy, exfiltrate customer data—you may screenshot redacted corroborating evidence;</li>
        <li>Allow Vrika reasonable time—typically up to 90 days—to remediate before public disclosure unless sooner
          coordinated;</li>
        <li>Cite CVE assignments when issuance completes.</li>
      </ul>

      <h2 id="thanks">Recognition</h2>
      <p>
        Verified critical findings may merit public thanks (with reporter consent), swag bundles, subscription credits consistent
        with policy, though no bounty is guaranteed absent a separately executed agreement.
      </p>

      <h2 id="safe-harbor">Safe harbor</h2>
      <p>
        Vrika will not initiate legal action against good-faith research meeting this policy unless laws compel otherwise
        or conduct remains reckless despite warnings.
      </p>
    </MarketingSubpage>
  );
}
