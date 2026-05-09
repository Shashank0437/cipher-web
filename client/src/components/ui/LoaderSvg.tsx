"use client";

import { useId, useSyncExternalStore } from "react";
import type { SVGProps } from "react";

type Props = Omit<SVGProps<SVGSVGElement>, "role" | "aria-busy"> & {
  label?: string;
};

const R = 26;
const CIRC = 2 * Math.PI * R;

function subscribeReducedMotion(cb: () => void) {
  const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}

function getReducedMotionSnapshot(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function getReducedMotionServerSnapshot(): boolean {
  return false;
}

export function LoaderSvg(props: Props) {
  const { label = "Loading", className, ...svgRest } = props;
  const uid = useId().replace(/:/g, "");
  const gid = `cs-loader-grad-${uid}`;
  const reduceMotion = useSyncExternalStore(
    subscribeReducedMotion,
    getReducedMotionSnapshot,
    getReducedMotionServerSnapshot,
  );

  const dashArc = `${Math.round(CIRC * 0.22)} ${Math.round(CIRC)}`;

  return (
    <span role="status" aria-busy="true" aria-label={label} className={className}>
      <svg
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="block h-full w-full overflow-visible"
        aria-hidden="true"
        focusable="false"
        {...svgRest}
      >
        <defs>
          <linearGradient id={gid} x1="8" y1="8" x2="56" y2="56" gradientUnits="userSpaceOnUse">
            <stop stopColor="#684cb6" />
            <stop offset="0.48" stopColor="#7c3aed" />
            <stop offset="1" stopColor="#22d3ee" />
          </linearGradient>
        </defs>

        {/* Closed track — reads as one full circle */}
        {!reduceMotion ? (
          <>
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke={`url(#${gid})`}
              strokeOpacity="0.22"
              strokeWidth="5"
            />
            <circle
              cx="32"
              cy="32"
              r={R}
              fill="none"
              stroke={`url(#${gid})`}
              strokeWidth="5"
              strokeLinecap="round"
              strokeDasharray={dashArc}
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 32 32"
                to="360 32 32"
                dur="1s"
                repeatCount="indefinite"
              />
            </circle>
          </>
        ) : (
          <circle cx="32" cy="32" r={R} fill="none" stroke={`url(#${gid})`} strokeWidth="5" strokeOpacity="0.45">
            <animate attributeName="opacity" values="0.35;0.9;0.35" dur="1.4s" repeatCount="indefinite" />
          </circle>
        )}
      </svg>
    </span>
  );
}
