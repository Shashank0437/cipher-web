import type { Metadata } from "next";
import { MarketingSubpage } from "@/components/layout/MarketingSubpage";

export const metadata: Metadata = {
  title: "Terms of Use | Vrika",
  description: "Terms governing use of Vrika websites, demos, and software.",
};

export default function TermsOfUsePage() {
  return (
    <MarketingSubpage
      title="Terms of Use"
      lastUpdated="May 8, 2026"
      toc={[
        { href: "#eligible-use", label: "Eligible use" },
        { href: "#accounts", label: "Accounts & credentials" },
        { href: "#license", label: "Limited license" },
        { href: "#conduct", label: "Responsible conduct" },
        { href: "#data", label: "Operational data" },
        { href: "#third-party", label: "Third-party tooling" },
        { href: "#disclaimers", label: "Disclaimers" },
        { href: "#liability", label: "Limitation of liability" },
        { href: "#changes", label: "Updates" },
        { href: "#contact", label: "Contact" },
      ]}
    >
      <p>
        These Terms of Use (&quot;Terms&quot;) describe the rules that apply when you access Vrika marketing sites,
        product demos, downloadable clients, documentation, or related services (collectively, the &quot;Services&quot;). By using
        the Services you agree to these Terms. If you do not agree, do not access or use them.
      </p>

      <h2 id="eligible-use">Eligible use</h2>
      <p>
        Vrika is offensive-security automation software intended for authorized testing only. You may use the Services
        exclusively in environments where you have explicit written authorization from the asset owner—including scope, timing,
        and rules of engagement. Any use outside permitted scope is prohibited and may violate law.
      </p>

      <h2 id="accounts">Accounts and credentials</h2>
      <p>
        Where registration is offered, you are responsible for maintaining accurate account details and safeguarding
        credentials. You must notify us promptly of unauthorized access if you suspect your account has been compromised.
      </p>

      <h2 id="license">Limited license</h2>
      <p>
        Subject to compliance with these Terms, Vrika grants you a limited, revocable, non-exclusive, non-transferable
        license to use the portions of software explicitly made available to you solely for lawful security operations aligned
        with your engagement letter or internal policy.
      </p>
      <p>You shall not—and shall not permit others—to:</p>
      <ul>
        <li>Use the Services to attack systems or users without authorization;</li>
        <li>Copy, scrape, sublicense, lease, distribute, reverse engineer (except where law forbids waiver), or resell;</li>
        <li>Use output to violate export controls, sanctions, or applicable cybersecurity regulations;</li>
        <li>Remove notices, circumvent technical limits, overload infrastructure, or probe for vulnerabilities unrelated to sanctioned tests.</li>
      </ul>

      <h2 id="conduct">Responsible conduct</h2>
      <p>
        You acknowledge that tooling can cause harm when misapplied. You accept responsibility for supervising operators,
        maintaining kill-switches where provided, enforcing human review steps, logging actions, and storing evidence securely.
      </p>

      <h2 id="data">Operational data</h2>
      <p>
        Depending on deployment, Vrika processes technical telemetry (targets, payloads, transcripts, artefacts, crash
        dumps). Separate privacy disclosures govern personal data retention; security findings must be handled consistent with your
        own policies and engagements.
      </p>

      <h2 id="third-party">Third-party tooling</h2>
      <p>
        Vrika may orchestrate third-party binaries (&quot;bring your own tools&quot;) under separate licenses issued by those
        vendors. You warrant that you comply with upstream license terms whenever agents invoke binaries you supply.
      </p>

      <h2 id="disclaimers">Disclaimers</h2>
      <p>
        THE SERVICES ARE PROVIDED &quot;AS IS&quot;. TO THE MAXIMUM EXTENT PERMITTED BY LAW, VRIKA DISCLAIMS WARRANTIES OF
        MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. NOTHING HERE CONSTITUTES LEGAL ADVICE REGARDING YOUR
        JURISDICTION&apos;S PENETRATION-TEST LAWS OR CONTRACTUAL OBLIGATIONS.
      </p>

      <h2 id="liability">Limitation of liability</h2>
      <p>
        TO THE EXTENT LAW ALLOWS, VRIKA&apos; TOTAL LIABILITY ARISING OUT OF THESE TERMS IS LIMITED TO THE FEES ACTUALLY
        PAID BY YOU IN THE TWELVE MONTHS PRECEDING THE CLAIM OR USD $100 WHICHEVER IS LESS. NEITHER PARTY IS LIABLE FOR
        CONSEQUENTIAL DAMAGES EXCEPT WHERE LIABILITY CANNOT BE EXCLUDED UNDER APPLICABLE LAW.
      </p>

      <h2 id="changes">Updates</h2>
      <p>
        Vrika may update these Terms. Material changes may be surfaced within the Services or emailed to admins of
        customer accounts where applicable.
      </p>

      <h2 id="contact">Contact</h2>
      <p>
        Legal notices should be routed through channels published for your Vrika tenant or mailed to your assigned account
        team. Responsible security reporting is described on the Responsible Disclosure page.
      </p>
    </MarketingSubpage>
  );
}
