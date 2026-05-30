"use client";

import { type FormEvent, useEffect, useId, useState } from "react";
import { createPortal } from "react-dom";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { ApiError, api } from "@/lib/api";

type ContactUsModalProps = {
  open: boolean;
  onClose: () => void;
};

/** Neutral inputs — same focus ring on every field (no “random” purple outline on one box). */
const field =
  "mt-2 h-11 w-full rounded-lg border border-neutral-200 bg-white px-3.5 text-[15px] text-neutral-900 outline-none transition-[box-shadow,border-color] placeholder:text-neutral-400 focus:border-primary focus:shadow-[0_0_0_3px_rgba(104,76,182,0.12)]";
const label = "text-[13px] font-medium text-neutral-600";

export function ContactUsModal({ open, onClose }: ContactUsModalProps) {
  const titleId = useId();
  const [mounted, setMounted] = useState(false);
  const [sent, setSent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmationSkipped, setConfirmationSkipped] = useState(false);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) {
      setSent(false);
      setSubmitting(false);
      setFormError(null);
      setConfirmationSkipped(false);
      setFirstName("");
      setLastName("");
      setEmail("");
      setCompany("");
      setPhone("");
      setMessage("");
    }
  }, [open]);

  if (!mounted || !open) return null;

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api<{ detail?: string; confirmation_sent?: boolean }>("/contact", {
        method: "POST",
        json: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          email: email.trim(),
          company: company.trim(),
          phone: phone.trim() || null,
          message: message.trim(),
        },
      });
      setConfirmationSkipped(res.confirmation_sent === false);
      setSent(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Something went wrong. Please try again.");
    } finally {
      setSubmitting(false);
    }
  };

  const overlay = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6">
      <button
        type="button"
        aria-label="Close dialog"
        className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
      />
      {/* `overflow-hidden` + single neutral shadow keeps corners crisp (no colored glow past the radius). */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="relative z-10 flex max-h-[min(92dvh,760px)] w-full max-w-[460px] flex-col overflow-hidden rounded-2xl bg-white shadow-[0_8px_32px_rgba(15,23,42,0.12)] ring-1 ring-black/[0.06]"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-neutral-100 px-6 py-5 sm:px-8">
          <div className="min-w-0 pr-2">
            <h2 id={titleId} className="text-xl font-semibold tracking-tight text-neutral-900 sm:text-2xl">
              Contact us
            </h2>
            <p className="mt-1 text-sm leading-relaxed text-neutral-500">
              Tell us about your team—we’ll follow up about Vrika access and demos.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex size-10 shrink-0 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
            aria-label="Close"
          >
            <MaterialSymbol name="close" className="text-[22px]" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-6 sm:px-8 sm:py-7">
          {sent ? (
            <div className="rounded-xl border border-neutral-200 bg-neutral-50/80 px-5 py-8 text-center">
              <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
                <MaterialSymbol name="check_circle" filled className="text-3xl text-primary" />
              </div>
              <p className="mt-4 text-lg font-semibold text-neutral-900">Thanks for reaching out</p>
              <p className="mt-2 text-sm leading-relaxed text-neutral-600">
                {confirmationSkipped ? (
                  <>
                    Your message was delivered to our team. We couldn’t send an automatic confirmation to your address just
                    now—check spam or try again later if you need a receipt.
                  </>
                ) : (
                  "We’ve emailed you a confirmation—check your inbox (and spam). A member of our team will reach out soon."
                )}
              </p>
              <button
                type="button"
                onClick={onClose}
                className="mt-6 rounded-lg bg-primary px-6 py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90"
              >
                Close
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="space-y-4">
              {formError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">{formError}</div>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className={label} htmlFor="cu-first">
                    First name
                  </label>
                  <input
                    id="cu-first"
                    name="firstName"
                    type="text"
                    autoComplete="given-name"
                    required
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    className={field}
                    placeholder="Jane"
                  />
                </div>
                <div>
                  <label className={label} htmlFor="cu-last">
                    Last name
                  </label>
                  <input
                    id="cu-last"
                    name="lastName"
                    type="text"
                    autoComplete="family-name"
                    required
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    className={field}
                    placeholder="Doe"
                  />
                </div>
              </div>
              <div>
                <label className={label} htmlFor="cu-email">
                  Work email
                </label>
                <input
                  id="cu-email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className={field}
                  placeholder="name@company.com"
                />
              </div>
              <div>
                <label className={label} htmlFor="cu-company">
                  Company <span className="text-neutral-400">· required for demo</span>
                </label>
                <input
                  id="cu-company"
                  name="company"
                  type="text"
                  autoComplete="organization"
                  required
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  className={field}
                  placeholder="Organization name"
                />
              </div>
              <div>
                <label className={label} htmlFor="cu-phone">
                  Phone <span className="font-normal text-neutral-400">(optional)</span>
                </label>
                <input
                  id="cu-phone"
                  name="phone"
                  type="tel"
                  autoComplete="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  className={field}
                  placeholder="+1 …"
                />
              </div>
              <div>
                <label className={label} htmlFor="cu-msg">
                  Message
                </label>
                <textarea
                  id="cu-msg"
                  name="message"
                  rows={4}
                  required
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className={`${field} min-h-[120px] resize-y py-3`}
                  placeholder="How can we help?"
                />
              </div>
              <button
                type="submit"
                disabled={submitting}
                className="mt-2 w-full rounded-lg bg-primary py-3.5 text-[15px] font-semibold text-white transition-opacity hover:opacity-95 disabled:opacity-50"
              >
                {submitting ? "Sending…" : "Send message"}
              </button>
              <p className="pt-1 text-center text-xs leading-relaxed text-neutral-400">
                By sending, you agree to our{" "}
                <a href="/terms-of-use" className="font-medium text-neutral-600 underline-offset-2 hover:underline">
                  Terms of Use
                </a>{" "}
                and{" "}
                <a href="/privacy-policy" className="font-medium text-neutral-600 underline-offset-2 hover:underline">
                  Privacy Policy
                </a>
                .
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
