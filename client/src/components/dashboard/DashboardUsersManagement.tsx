"use client";

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MaterialSymbol } from "@/components/ui/MaterialSymbol";
import { ApiError, api } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

type MemberRow = {
  id: string;
  email: string;
  username: string;
  roles: string[];
};

function badgeForRoles(roles: string[]): string {
  if (roles.includes("tenant_admin")) return "ADMIN";
  return "USER";
}

function badgeCls(label: string) {
  return label === "ADMIN"
    ? "bg-primary-container text-on-primary-container ring-1 ring-primary/25"
    : "bg-surface-container-high text-on-surface-variant ring-1 ring-outline-variant";
}

export function DashboardUsersManagement() {
  const router = useRouter();
  const { user, loading } = useAuth();
  const [rows, setRows] = useState<MemberRow[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteUsername, setInviteUsername] = useState("");
  const [inviteRole, setInviteRole] = useState<"tenant_member" | "tenant_admin">("tenant_member");
  const [submitting, setSubmitting] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const isAdmin = !!(user?.roles?.includes("tenant_admin"));

  const loadMembers = useCallback(async () => {
    if (!user || !isAdmin) return;
    setFetchError(null);
    try {
      const list = await api<MemberRow[]>("/tenant/members");
      setRows(list);
    } catch (e) {
      setFetchError(e instanceof ApiError ? e.message : "Could not load members");
    }
  }, [user, isAdmin]);

  useEffect(() => {
    if (!loading && user && !isAdmin) {
      router.replace("/dashboard");
    }
  }, [loading, user, isAdmin, router]);

  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const onInvite = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setFormError(null);
    try {
      await api("/tenant/invitations", {
        method: "POST",
        json: { email: inviteEmail.trim(), username: inviteUsername.trim(), role: inviteRole },
      });
      setSuccessMsg(`Invitation sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      setInviteUsername("");
      setInviteRole("tenant_member");
      setModalOpen(false);
      void loadMembers();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Invite failed");
    } finally {
      setSubmitting(false);
    }
  };

  if (loading || !user || !isAdmin) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-on-surface-variant">
        <p className="text-sm">Loading…</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-10 pb-20">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-primary">User management</p>
          <h1 className="mt-2 text-[1.75rem] font-bold tracking-tight text-on-surface">Organization members</h1>
          <p className="mt-2 max-w-xl text-[15px] leading-relaxed text-on-surface-variant">
            Invite teammates to this workspace by email. Invitees finish registration with their own password link.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setSuccessMsg(null);
            setFormError(null);
            setModalOpen(true);
          }}
          className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl bg-primary px-5 text-[14px] font-semibold text-on-primary shadow-sm hover:bg-primary-dim"
        >
          <MaterialSymbol name="person_add" className="text-lg" filled />
          Invite user
        </button>
      </div>

      {successMsg ? (
        <div className="mt-6 rounded-xl border border-outline-variant bg-emerald-50/80 px-4 py-3 text-sm font-medium text-emerald-950 shadow-sm ring-1 ring-emerald-200/70">
          {successMsg}
        </div>
      ) : null}
      {fetchError ? (
        <div className="mt-6 rounded-xl border border-error/30 bg-red-50 px-4 py-3 text-sm text-red-900">{fetchError}</div>
      ) : null}

      <div className="mt-8 overflow-hidden rounded-2xl border border-outline-variant bg-surface shadow-sm">
        <table className="min-w-full border-collapse text-left text-[14px]">
          <thead>
            <tr className="border-b border-outline-variant text-[11px] font-bold uppercase tracking-wider text-on-surface-variant">
              <th className="px-5 py-3.5">Username</th>
              <th className="px-5 py-3.5">Email</th>
              <th className="px-5 py-3.5">Role</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const b = badgeForRoles(row.roles);
              return (
                <tr key={row.id} className="border-b border-outline-variant/80 hover:bg-primary-container/[0.12]">
                  <td className="px-5 py-4 font-semibold text-on-surface">{row.username || "—"}</td>
                  <td className="px-5 py-4 text-on-surface-variant">{row.email}</td>
                  <td className="px-5 py-4">
                    <span className={`inline-flex rounded-full px-3 py-1 text-[11px] font-bold ${badgeCls(b)}`}>
                      {b}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {modalOpen ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div
            role="dialog"
            aria-labelledby="invite-title"
            className="w-full max-w-md rounded-2xl border border-outline-variant bg-surface p-6 shadow-xl"
          >
            <div className="flex items-start justify-between gap-2">
              <h2 id="invite-title" className="text-lg font-bold text-on-surface">
                Invite teammate
              </h2>
              <button
                type="button"
                aria-label="Close"
                className="rounded-lg p-1 text-on-surface-variant hover:bg-surface-container-high"
                onClick={() => setModalOpen(false)}
              >
                <MaterialSymbol name="close" />
              </button>
            </div>
            <p className="mt-2 text-sm text-on-surface-variant">
              They will receive an email to accept and choose a password. Existing CipherStrike accounts are not inviteable here.
            </p>
            <form onSubmit={onInvite} className="mt-6 space-y-4">
              {formError ? (
                <div className="rounded-lg border border-error/40 bg-red-50 px-3 py-2 text-sm text-red-900">{formError}</div>
              ) : null}
              <div>
                <label className="text-[13px] font-medium text-on-surface-variant" htmlFor="inv-email">
                  Email
                </label>
                <input
                  id="inv-email"
                  type="email"
                  required
                  value={inviteEmail}
                  onChange={(ev) => setInviteEmail(ev.target.value)}
                  className="mt-1.5 h-11 w-full rounded-xl border border-outline-variant px-3.5 text-[15px] outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-[13px] font-medium text-on-surface-variant" htmlFor="inv-user">
                  Display name / username
                </label>
                <input
                  id="inv-user"
                  required
                  value={inviteUsername}
                  onChange={(ev) => setInviteUsername(ev.target.value)}
                  className="mt-1.5 h-11 w-full rounded-xl border border-outline-variant px-3.5 text-[15px] outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                />
              </div>
              <div>
                <label className="text-[13px] font-medium text-on-surface-variant" htmlFor="inv-role">
                  Workspace role
                </label>
                <select
                  id="inv-role"
                  value={inviteRole}
                  onChange={(ev) =>
                    setInviteRole(ev.target.value as "tenant_member" | "tenant_admin")
                  }
                  className="mt-1.5 h-11 w-full rounded-xl border border-outline-variant bg-white px-3.5 text-[15px] outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="tenant_member">USER (member)</option>
                  <option value="tenant_admin">ADMIN (tenant administrator)</option>
                </select>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="h-11 rounded-xl px-4 text-sm font-semibold text-on-surface-variant hover:bg-surface-container-high"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submitting}
                  className="h-11 rounded-xl bg-primary px-5 text-sm font-semibold text-on-primary hover:bg-primary-dim disabled:opacity-50"
                >
                  {submitting ? "Sending…" : "Send invite"}
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
