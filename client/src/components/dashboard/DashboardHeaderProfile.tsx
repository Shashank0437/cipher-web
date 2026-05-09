"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { ApiError, api } from "@/lib/api";
import type { AuthUser } from "@/lib/auth-context";
import { useAuth } from "@/lib/auth-context";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";

function avatarInitials(user: AuthUser): string {
  const name = user.username?.trim();
  if (name && name.length >= 2) return `${name[0]}${name[1]}`.toUpperCase();
  const mail = user.email?.trim() || "?";
  return mail.slice(0, 2).toUpperCase();
}

function PasswordField({
  id,
  label,
  placeholder,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className="text-[13px] font-medium text-neutral-600">
        {label}
      </label>
      <div className="relative mt-1.5">
        <input
          id={id}
          type={show ? "text" : "password"}
          autoComplete={id.includes("old") ? "current-password" : "new-password"}
          placeholder={placeholder}
          disabled={disabled}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-11 w-full rounded-xl border border-neutral-200 bg-neutral-50/80 px-3.5 pr-11 text-[15px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label={show ? "Hide password" : "Show password"}
          className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-primary hover:bg-primary-container/60"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setShow((s) => !s)}
        >
          <MaterialSymbol name={show ? "visibility_off" : "visibility"} className="text-xl" />
        </button>
      </div>
    </div>
  );
}

function UpdatePasswordModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [currentPwd, setCurrentPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [confirmPwd, setConfirmPwd] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose, mounted]);

  useEffect(() => {
    if (!open) {
      setCurrentPwd("");
      setNewPwd("");
      setConfirmPwd("");
      setError(null);
      setSuccess(false);
      setSubmitting(false);
    }
  }, [open]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (newPwd.length < 8) {
      setError("New password must be at least 8 characters.");
      return;
    }
    if (newPwd !== confirmPwd) {
      setError("New password and confirmation do not match.");
      return;
    }
    setSubmitting(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        json: { current_password: currentPwd, new_password: newPwd },
      });
      setSuccess(true);
      window.setTimeout(() => {
        onClose();
      }, 900);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update password.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center overflow-y-auto bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="upd-pw-title"
        className="relative my-auto w-full max-w-[420px] rounded-2xl bg-white shadow-[0_24px_64px_-12px_rgba(104,76,182,0.35)] ring-1 ring-neutral-200/90"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-neutral-100 px-6 py-4">
          <button
            type="button"
            aria-label="Close"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-neutral-600 hover:bg-neutral-100"
            onClick={onClose}
          >
            <MaterialSymbol name="arrow_back" className="text-xl" />
          </button>
          <h2 id="upd-pw-title" className="text-[17px] font-bold tracking-tight text-neutral-900">
            Update Password
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-6">
          {success ? (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-medium text-emerald-900">
              Password updated successfully.
            </div>
          ) : null}
          {error ? (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
          ) : null}

          <PasswordField
            id="old-password"
            label="Old Password"
            placeholder="Enter old Password"
            value={currentPwd}
            onChange={setCurrentPwd}
            disabled={submitting || success}
          />
          <PasswordField
            id="new-password"
            label="New Password"
            placeholder="Enter New Password"
            value={newPwd}
            onChange={setNewPwd}
            disabled={submitting || success}
          />
          <PasswordField
            id="confirm-password"
            label="Confirm Password"
            placeholder="Enter Confirm Password"
            value={confirmPwd}
            onChange={setConfirmPwd}
            disabled={submitting || success}
          />

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              disabled={submitting || success}
              className="h-11 flex-1 rounded-full border border-neutral-300 bg-white text-[15px] font-semibold text-primary hover:bg-neutral-50 disabled:opacity-50"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || success}
              className="h-11 flex-1 rounded-full bg-[#b8a8ff] text-[15px] font-semibold text-white shadow-sm hover:bg-[#a894ff] disabled:opacity-50"
              style={{ backgroundImage: "linear-gradient(135deg,#b8a8ff,#9d84ff)" }}
            >
              {submitting ? "Updating…" : "Update"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

function EditProfileModal({
  open,
  onClose,
  initialUsername,
}: {
  open: boolean;
  onClose: () => void;
  initialUsername: string;
}) {
  const { updateProfile } = useAuth();
  const [mounted, setMounted] = useState(false);
  const [username, setUsername] = useState(initialUsername);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!open || !mounted) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose, mounted]);

  useEffect(() => {
    if (open) {
      setUsername(initialUsername);
      setError(null);
      setSubmitting(false);
    }
  }, [open, initialUsername]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = username.trim();
    if (!trimmed) {
      setError("Display name cannot be empty.");
      return;
    }
    setSubmitting(true);
    try {
      await updateProfile({ username: trimmed });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update profile.");
    } finally {
      setSubmitting(false);
    }
  };

  if (!open || !mounted) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center overflow-y-auto bg-black/45 p-4 backdrop-blur-[2px]"
      role="presentation"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-profile-title"
        className="relative my-auto w-full max-w-[420px] rounded-2xl bg-white shadow-[0_24px_64px_-12px_rgba(104,76,182,0.35)] ring-1 ring-neutral-200/90"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-neutral-100 px-6 py-4">
          <button
            type="button"
            aria-label="Close"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl text-neutral-600 hover:bg-neutral-100"
            onClick={onClose}
          >
            <MaterialSymbol name="arrow_back" className="text-xl" />
          </button>
          <h2 id="edit-profile-title" className="text-[17px] font-bold tracking-tight text-neutral-900">
            Edit profile
          </h2>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4 px-6 py-6">
          {error ? (
            <div className="rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-900">{error}</div>
          ) : null}

          <div>
            <label htmlFor="edit-display-name" className="text-[13px] font-medium text-neutral-600">
              Display name / username
            </label>
            <input
              id="edit-display-name"
              type="text"
              autoComplete="username"
              maxLength={120}
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={submitting}
              className="mt-1.5 h-11 w-full rounded-xl border border-neutral-200 bg-neutral-50/80 px-3.5 text-[15px] text-neutral-900 outline-none placeholder:text-neutral-400 focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
              placeholder="Your name"
            />
          </div>

          <div className="flex gap-3 pt-4">
            <button
              type="button"
              disabled={submitting}
              className="h-11 flex-1 rounded-full border border-neutral-300 bg-white text-[15px] font-semibold text-primary hover:bg-neutral-50 disabled:opacity-50"
              onClick={onClose}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="h-11 flex-1 rounded-full bg-[#b8a8ff] text-[15px] font-semibold text-white shadow-sm hover:bg-[#a894ff] disabled:opacity-50"
              style={{ backgroundImage: "linear-gradient(135deg,#b8a8ff,#9d84ff)" }}
            >
              {submitting ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  );
}

export function DashboardHeaderProfile({ user }: { user: AuthUser }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [pwModalOpen, setPwModalOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const { logout } = useAuth();

  useEffect(() => {
    if (!menuOpen) return;
    const el = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", el);
    return () => document.removeEventListener("mousedown", el);
  }, [menuOpen]);

  const initials = avatarInitials(user);
  const displayName = user.username?.trim() || user.email.split("@")[0];

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-3 rounded-full py-1 pr-1 pl-2 hover:bg-surface-container-high md:pl-3"
        aria-expanded={menuOpen}
        aria-haspopup="true"
      >
        <span className="hidden max-w-[220px] truncate text-sm text-on-surface-variant md:inline">{user.email}</span>
        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary-container text-[13px] font-bold text-primary ring-2 ring-transparent transition-[box-shadow] hover:ring-primary/30">
          {initials}
        </span>
      </button>

      {menuOpen ? (
        <>
          <div className="fixed inset-0 z-[9990] bg-black/30 sm:hidden" aria-hidden onClick={() => setMenuOpen(false)} />
          <div className="absolute top-full right-0 z-[9991] mt-2 w-[300px] rounded-2xl border border-outline-variant bg-white py-3 shadow-[0_16px_48px_-12px_rgba(104,76,182,0.38)] ring-1 ring-neutral-100">
            <div className="flex items-start gap-3 px-4 pb-3 pt-1">
              <span className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary-container text-base font-bold text-primary">
                {initials}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="truncate text-[15px] font-bold text-primary">{displayName}</p>
                <p className="truncate text-[13px] leading-snug text-on-surface-variant">{user.email}</p>
              </div>
              <button
                type="button"
                aria-label="Edit profile"
                title="Edit display name"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition-colors hover:bg-primary-container/60 hover:text-primary"
                onClick={() => {
                  setMenuOpen(false);
                  setProfileModalOpen(true);
                }}
              >
                <MaterialSymbol name="edit" className="text-lg" filled />
              </button>
            </div>

            <div className="mx-3 border-t border-neutral-100" />

            <div className="px-2 pt-2 pb-1">
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium text-neutral-700 hover:bg-neutral-50"
                onClick={() => {
                  setMenuOpen(false);
                  setPwModalOpen(true);
                }}
              >
                <MaterialSymbol name="lock" className="text-[22px] text-neutral-500" filled />
                Update Password
              </button>
              <button
                type="button"
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14px] font-medium text-neutral-700 hover:bg-neutral-50"
                onClick={() => logout()}
              >
                <MaterialSymbol name="logout" className="text-[22px] text-neutral-500" filled />
                Logout
              </button>
            </div>
          </div>
        </>
      ) : null}

      <UpdatePasswordModal open={pwModalOpen} onClose={() => setPwModalOpen(false)} />
      <EditProfileModal
        open={profileModalOpen}
        onClose={() => setProfileModalOpen(false)}
        initialUsername={user.username?.trim() || user.email.split("@")[0] || ""}
      />
    </div>
  );
}
