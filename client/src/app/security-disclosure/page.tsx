import type { Metadata } from "next";
import { MarketingSubpage } from "@/components/layout/MarketingSubpage";

export const metadata: Metadata = {
  title: "Security Disclosure | CipherStrike",
  description: "CipherStrike security posture, monitoring commitments, and customer expectations.",
};

export default function SecurityDisclosurePage() {
  return (
    <MarketingSubpage
      title="Security Disclosure"
      lastUpdated="May 8, 2026"
      toc={[
        { href: "#design", label: "Design principles" },
        { href: "#crypto", label: "Cryptography" },
        { href: "#vuln", label: "Vulnerability handling" },
        { href: "#dependencies", label: "Dependencies & supply chain" },
        { href: "#customer", label: "Customer responsibilities" },
        { href: "#report", label: "Questions & incidents" },
      ]}
    >
      <p>
        CipherStrike acknowledges that autonomous offensive tooling increases blast radius without rigorous controls. This
        disclosure summarizes how CipherStrike safeguards its SaaS perimeter, hardened agent runtime, cryptography usage, tenant
        isolation, anomaly detection, patching cadence philosophy, transparency expectations, plus how customers should compensate
        residual risk.
      </p>

      <h2 id="design">Design principles</h2>
      <ul>
        <li>
          <strong>Least privilege by default</strong>—service accounts only receive automation grants after policy approval.
        </li>
        <li>
          <strong>Segregation</strong>—multi-tenant clusters rely on namespace isolation, network policies, encrypted volumes, and
          rotating credentials.
        </li>
        <li>
          <strong>Observability</strong>—immutable audit logs for operator actions, agent dispatches, secret vault calls, policy
          violations.
        </li>
      </ul>

      <h2 id="crypto">Cryptography &amp; transport</h2>
      <p>
        Control-plane traffic uses TLS 1.2+ with modern ciphers. Optional mTLS is available for enterprise deployments. Long-lived
        secrets should remain in customer vaults with short-lived session tokens brokered at execution time.
      </p>

      <h2 id="vuln">Vulnerability handling</h2>
      <p>
        External researchers should follow the Responsible Disclosure program. Internally, severity ratings map to SLAs: critical
        remote-exec class issues triage within hours, high within one business day, medium within one week for mitigations or
        compensating controls.
      </p>

      <h2 id="dependencies">Dependencies &amp; supply chain</h2>
      <p>
        Third-party packages are scanned for known CVEs on each release train. SBOM exports are available to enterprise
        subscribers. Customers remain responsible for orchestrated community tools they mount into agent sandboxes.
      </p>

      <h2 id="customer">Customer responsibilities</h2>
      <p>
        You must maintain endpoint protection on operator laptops, segment lab networks, patch underlying hypervisors, disable
        unused integrations, and rotate API keys. CipherStrike cannot guarantee safety if infrastructure outside our boundary is
        neglected.
      </p>

      <h2 id="report">Questions</h2>
      <p>
        For contractual security exhibits (SIG questionnaires, ISO mappings, pen-test summaries) contact your customer success
        director. For suspected incidents open a ticket through the secure portal provided after onboarding.
      </p>
    </MarketingSubpage>
  );
}
