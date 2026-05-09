import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * Browser calls `/be/*` (see `src/lib/env.ts`).
 * Streaming APIs must NOT use `rewrites()` — Next buffers SSE through external rewrites.
 * Proxy implementation: `src/app/be/[[...path]]/route.ts`.
 */
const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: appDir,
  },
};

export default nextConfig;
