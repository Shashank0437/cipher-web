import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

/**
 * Streaming-safe proxy to the FastAPI backend.
 *
 * `next.config` rewrites buffer many streaming / SSE responses, so the UI sees one big chunk.
 * This handler forwards the upstream body as a ReadableStream while preserving headers.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "host",
]);

function backendOrigin(): string {
  const raw =
    process.env.PY_API_URL?.trim() ||
    process.env.INTERNAL_API_URL?.trim() ||
    "http://127.0.0.1:8000";
  return raw.replace(/\/$/, "");
}

function targetUrl(req: NextRequest, segments: string[]): string {
  const base = backendOrigin();
  const subpath = segments.length ? segments.join("/") : "";
  const qs = req.nextUrl.search;
  return subpath ? `${base}/${subpath}${qs}` : `${base}${qs}`;
}

async function proxy(req: NextRequest, segments: string[]): Promise<Response> {
  const url = targetUrl(req, segments);

  const headers = new Headers();
  req.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      headers.set(key, value);
    }
  });

  const init: RequestInit & { duplex?: "half" } = {
    method: req.method,
    headers,
    redirect: "manual",
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = req.body;
    init.duplex = "half";
  }

  return fetch(url, init);
}

function streamingResponse(upstream: Response): NextResponse {
  const out = new Headers(upstream.headers);
  const ctype = out.get("content-type") || "";
  // Forwarding a literal Content-Length with a chunked/streaming body breaks progressive delivery in
  // some fetch/undici paths; SSE from FastAPI should be chunked without CL — strip if present.
  if (ctype.includes("text/event-stream")) {
    out.delete("content-length");
  }
  if (!out.has("Cache-Control")) {
    out.set("Cache-Control", "no-cache");
  }
  out.set("X-Accel-Buffering", "no");

  let body: BodyInit | null = upstream.body;
  if (ctype.includes("text/event-stream") && upstream.body) {
    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable).catch((err) => {
      console.error("Upstream stream pipe error:", err);
    });
    body = readable;
  }

  return new NextResponse(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

async function handle(req: NextRequest, ctx: { params: Promise<{ path?: string[] }> }) {
  const { path } = await ctx.params;
  const segments = path ?? [];
  try {
    const upstream = await proxy(req, segments);
    return streamingResponse(upstream);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: "upstream_unreachable", detail: msg },
      { status: 502 },
    );
  }
}

export const GET = handle;
export const HEAD = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const OPTIONS = handle;
