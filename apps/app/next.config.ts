import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Server Action origins are validated against the request Origin header. Next
// already allows same-origin; `allowedOrigins` covers proxied setups. Keep prod
// hostnames out of source: derive them from the platform env vars, with an
// explicit SERVER_ACTIONS_ALLOWED_ORIGINS escape hatch.
const serverActionsAllowedOrigins = [
  "localhost:3000",
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  ...(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(",") ?? []),
]
  .map((o) => o?.trim())
  .filter((o): o is string => Boolean(o));

const honoApiBase = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

const nextConfig: NextConfig = {
  // Deploy parity: tools/scripts/package-for-node.sh sets STANDALONE=1 and
  // assembles apps/app. The packages in serverExternalPackages are not bundled
  // into the standalone output, so the deploy carries a real node_modules built
  // with `pnpm deploy --prod`.
  ...(process.env.STANDALONE === "1" ? { output: "standalone" as const } : {}),
  cacheComponents: true,
  partialPrefetching: true, // 16.3 Instant Navigations: shells prefetch, data streams
  typedRoutes: true,
  reactCompiler: true,
  // `next dev` would otherwise write AGENTS.md/CLAUDE.md into apps/app. Agent
  // instructions live in the repo-root CLAUDE.md and AGENTS.md, under review.
  agentRules: false,
  typescript: {
    // The CI `checks` job type-checks authoritatively (`tsc --noEmit`, TS 7). A
    // second pass inside `next build` reserves another large heap and OOMs the
    // 2-core e2e runner, so the build skips it.
    ignoreBuildErrors: true,
  },
  experimental: {
    serverActions: { allowedOrigins: serverActionsAllowedOrigins },
  },
  // Workspace packages export TypeScript source.
  transpilePackages: [
    "@oxagen/auth",
    "@oxagen/database",
    "@oxagen/oxagen",
    "@oxagen/ui",
  ],
  // Carried over from apps/app_deprecated/next.config.mjs: server-only packages
  // with native addons (blake3, duckdb, ssh2, dockerode) and the lazy-loaded heavy
  // workspace packages reached through instrumentation.ts and the kernel. Drop an
  // entry only once no imported package needs it.
  serverExternalPackages: [
    "@oxagen/agent",
    "@oxagen/engram",
    "blake3",
    "duckdb",
    "@mapbox/node-pre-gyp",
    "nock",
    "mock-aws-s3",
    "dockerode",
    "ssh2",
  ],
  // Turbopack's NodePreGypConfigReference parser needs `napi_versions` in a
  // package's `binary` field; blake3 and duckdb omit it and fail the build even
  // though they are external. Aliasing them to a throwing stub keeps Turbopack
  // out of their package.json. At runtime @oxagen/engram falls back to SHA-256
  // when blake3 is unavailable, and duckdb is only reached through externals.
  turbopack: {
    resolveAlias: {
      blake3: "./native-addon-stub.js",
      duckdb: "./native-addon-stub.js",
    },
  },
  images: {
    // Vercel Blob public URLs and OAuth-provided avatars (Google, GitHub).
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "*.githubusercontent.com" },
    ],
  },
  // Proxy /api/v1/* to the Hono API so browser calls stay same-origin. The
  // `fallback` phase runs after every filesystem route, so a local handler
  // always wins over the proxy.
  rewrites() {
    return Promise.resolve({
      fallback: [
        { source: "/api/v1/:path*", destination: `${honoApiBase}/v1/:path*` },
      ],
    });
  },
};

export default createNextIntlPlugin("./src/i18n/request.ts")(nextConfig);
