import { getApiBase } from "./env";
import { bumpApiPending } from "./api-pending";

const TOKEN_KEY = "vrika_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export async function api<T>(
  path: string,
  opts?: RequestInit & { json?: unknown },
): Promise<T> {
  if (typeof window !== "undefined") bumpApiPending(1);
  try {
    const headers = new Headers(opts?.headers);
    if (!headers.has("Content-Type") && opts?.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const token = typeof window !== "undefined" ? getToken() : null;
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const { json, ...rest } = opts ?? {};
    const res = await fetch(`${getApiBase()}${path}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = res.statusText || "Request failed";
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        if (typeof j.detail === "string") msg = j.detail;
        else if (Array.isArray(j.detail)) msg = JSON.stringify(j.detail);
      } catch {
        /* keep msg */
      }
      throw new ApiError(msg, res.status, text);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    if (typeof window !== "undefined") bumpApiPending(-1);
  }
}

/** Same as `api` but never attaches `Authorization` (public preview / signup flows while another session may be stored). */
export async function apiPublic<T>(
  path: string,
  opts?: RequestInit & { json?: unknown },
): Promise<T> {
  if (typeof window !== "undefined") bumpApiPending(1);
  try {
    const headers = new Headers(opts?.headers);
    if (!headers.has("Content-Type") && opts?.json !== undefined) {
      headers.set("Content-Type", "application/json");
    }
    const { json, ...rest } = opts ?? {};
    const res = await fetch(`${getApiBase()}${path}`, {
      ...rest,
      headers,
      body: json !== undefined ? JSON.stringify(json) : rest.body,
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = res.statusText || "Request failed";
      try {
        const j = JSON.parse(text) as { detail?: unknown };
        if (typeof j.detail === "string") msg = j.detail;
        else if (Array.isArray(j.detail)) msg = JSON.stringify(j.detail);
      } catch {
        /* keep msg */
      }
      throw new ApiError(msg, res.status, text);
    }
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  } finally {
    if (typeof window !== "undefined") bumpApiPending(-1);
  }
}
