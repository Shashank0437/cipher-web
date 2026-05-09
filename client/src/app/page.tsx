import type { Metadata } from "next";
import { StitchLandingPage } from "@/components/stitch/StitchLandingPage";

/**
 * Google Stitch — CipherStrike marketing landing (project 3983447513859599936).
 * https://stitch.withgoogle.com/preview/3983447513859599936?node-id=8f6abae9a75c49d8969ac7a231fc16f2
 *
 * Signed-in users can still open `/`; the app is reached via Login / Open workspace, not an automatic redirect.
 */
export const metadata: Metadata = {
  title: "CipherStrike | Offensive Security",
  description:
    "Orchestrate 147+ security tools with specialized agents. Autonomous offensive security platform.",
};

export default function LandingPage() {
  return <StitchLandingPage />;
}
