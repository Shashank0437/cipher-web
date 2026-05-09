import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const appDir = path.dirname(fileURLToPath(import.meta.url));

/** FastAPI (Python) origin — browser hits `/be/*` and Next proxies here. */
const pyApiOrigin = process.env.PY_API_URL ?? "http://127.0.0.1:8000";

const nextConfig: NextConfig = {
  output: "standalone",
  turbopack: {
    root: appDir,
  },
  async rewrites() {
    return [
      {
        source: "/be/:path*",
        destination: `${pyApiOrigin.replace(/\/$/, "")}/:path*`,
      },
    ];
  },
};

export default nextConfig;
