/**
 * Base URL for the FastAPI server.
 * - If `NEXT_PUBLIC_API_URL` is set, use it (direct calls to Uvicorn).
 * - Otherwise the browser uses same-origin `/be` (proxied by Next.js to the Python API).
 * - During SSR, falls back to `INTERNAL_API_URL` or `http://127.0.0.1:8000`.
 */
export function getApiBase(): string {
  const explicit = process.env.NEXT_PUBLIC_API_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, "");
  if (typeof window !== "undefined") return "/be";
  return (
    process.env.INTERNAL_API_URL?.trim()?.replace(/\/$/, "") || "http://127.0.0.1:8000"
  );
}
