"use client";

import { useEffect, useRef } from "react";

export function DemoVideo({ src, posterClass }: { src: string; posterClass?: string }) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const keepSilent = () => {
      if (!el.muted || el.volume > 0) {
        el.volume = 0;
        el.muted = true;
      }
    };

    el.defaultMuted = true;
    keepSilent();
    el.addEventListener("volumechange", keepSilent);
    return () => el.removeEventListener("volumechange", keepSilent);
  }, [src]);

  return (
    <div
      className={`relative overflow-hidden rounded-3xl border border-white/15 bg-black/60 shadow-2xl shadow-primary/20 ring-1 ring-white/10 ${posterClass ?? ""}`}
    >
      <div className="relative aspect-video w-full bg-black">
        <video
          ref={ref}
          className="aspect-video size-full object-cover opacity-75"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          controls
          controlsList="nodownload"
        >
          <source src={src} type="video/mp4" />
        </video>
        <div className="pointer-events-none absolute inset-0 rounded-[inherit] bg-black/25" aria-hidden />
      </div>
    </div>
  );
}
