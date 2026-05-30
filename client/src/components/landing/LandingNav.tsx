"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ContactUsModal } from "@/components/landing/ContactUsModal";
import { LandingAuthLink, LandingHeroPrimaryCta } from "@/components/stitch/LandingAuthCta";

export function LandingNav() {
  const [elevated, setElevated] = useState(false);
  const [contactOpen, setContactOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setElevated(window.scrollY > 48);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={`fixed top-0 left-0 right-0 z-50 border-b transition-colors duration-300 ${
        elevated
          ? "border-outline-variant bg-background/93 text-on-surface backdrop-blur-xl"
          : "border-transparent bg-[#07040f]/30 text-white backdrop-blur-md"
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-6 py-4">
        <Link href="/" className="flex items-center gap-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={elevated ? "/logo_with_text_with_shield.png" : "/logo_with_white_text_shield.png"}
            alt="Vrika"
            className="h-[64px] md:h-[72px] w-auto object-contain"
          />
        </Link>
        <nav className="hidden items-center gap-8 text-sm font-semibold md:flex">
          <a href="#demo" className={elevated ? "text-on-surface-variant hover:text-primary" : "text-white/80 hover:text-white"}>
            Demo
          </a>
          <a href="#pulse" className={elevated ? "text-on-surface-variant hover:text-primary" : "text-white/80 hover:text-white"}>
            Highlights
          </a>
          <LandingAuthLink
            href="/login"
            signedInHref="/tools"
            className={elevated ? "text-on-surface-variant hover:text-primary" : "text-white/80 hover:text-white"}
          >
            Arsenal
          </LandingAuthLink>
          <a href="#intel" className={elevated ? "text-on-surface-variant hover:text-primary" : "text-white/80 hover:text-white"}>
            Playbooks
          </a>
          <a href="#faq" className={elevated ? "text-on-surface-variant hover:text-primary" : "text-white/80 hover:text-white"}>
            FAQ
          </a>
        </nav>
        <div className="flex items-center gap-1 sm:gap-2 md:gap-3">
          <button
            type="button"
            onClick={() => setContactOpen(true)}
            className={`shrink-0 rounded-full px-3 py-2 text-sm font-semibold transition-colors sm:px-4 ${
              elevated
                ? "text-on-surface-variant hover:bg-surface-container hover:text-primary"
                : "text-white/85 hover:bg-white/10 hover:text-white"
            }`}
          >
            <span className="sm:hidden">Contact</span>
            <span className="hidden sm:inline">Contact us</span>
          </button>
          <LandingHeroPrimaryCta
            className={`rounded-full px-4 py-2.5 text-sm font-bold transition-colors sm:px-5 ${
              elevated
                ? "bg-primary text-on-primary shadow-lg shadow-primary/25 hover:opacity-90"
                : "bg-white text-[#170b29] hover:bg-white/85"
            }`}
          />
        </div>
      </div>
      <ContactUsModal open={contactOpen} onClose={() => setContactOpen(false)} />
    </header>
  );
}
