"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { api, apiPublic, clearToken, getToken, setToken } from "./api";

export type AuthUser = {
  id: string;
  email: string;
  username: string;
  tenant_id: string;
  roles: string[];
  organization_name?: string;
};

type RegisterRequestPayload = {
  email: string;
  username: string;
  company_name: string;
  phone: string;
};

type AuthContextValue = {
  user: AuthUser | null;
  loading: boolean;
  login: (email: string, password: string, redirectTo?: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
  updateProfile: (payload: { username: string }) => Promise<void>;
  registerRequest: (payload: RegisterRequestPayload) => Promise<void>;
  completeRegistration: (token: string, password: string, redirectTo?: string) => Promise<void>;
  completeInvitation: (token: string, password: string, redirectTo?: string) => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();

  const refreshUser = useCallback(async () => {
    const t = getToken();
    if (!t) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      const me = await api<AuthUser>("/auth/me");
      setUser(me);
    } catch {
      clearToken();
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshUser();
  }, [refreshUser]);

  const login = useCallback(
    async (email: string, password: string, redirectTo = "/dashboard") => {
      const res = await api<{ access_token: string }>("/auth/login", {
        method: "POST",
        json: { email, password },
      });
      setToken(res.access_token);
      await refreshUser();
      router.push(redirectTo);
    },
    [refreshUser, router],
  );

  const registerRequest = useCallback(async (payload: RegisterRequestPayload) => {
    await api("/auth/register-request", {
      method: "POST",
      json: payload,
    });
  }, []);

  const completeRegistration = useCallback(
    async (token: string, password: string, redirectTo = "/dashboard") => {
      const res = await api<{ access_token: string }>("/auth/complete-registration", {
        method: "POST",
        json: { token, password },
      });
      setToken(res.access_token);
      await refreshUser();
      router.push(redirectTo);
    },
    [refreshUser, router],
  );

  const completeInvitation = useCallback(
    async (token: string, password: string, redirectTo = "/dashboard") => {
      const res = await apiPublic<{ access_token: string }>("/auth/complete-invitation", {
        method: "POST",
        json: { token, password },
      });
      setToken(res.access_token);
      await refreshUser();
      router.push(redirectTo);
    },
    [refreshUser, router],
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
    router.push("/login");
  }, [router]);

  const updateProfile = useCallback(
    async ({ username }: { username: string }) => {
      await api("/auth/me", {
        method: "PATCH",
        json: { username },
      });
      await refreshUser();
    },
    [refreshUser],
  );

  const value = useMemo(
    () => ({
      user,
      loading,
      login,
      logout,
      refreshUser,
      updateProfile,
      registerRequest,
      completeRegistration,
      completeInvitation,
    }),
    [
      user,
      loading,
      login,
      logout,
      refreshUser,
      updateProfile,
      registerRequest,
      completeRegistration,
      completeInvitation,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
