// Server Action origins are validated against the request Origin header. Next
// already allows same-origin; `allowedOrigins` covers proxied setups (Vercel
// forwards a different Host than the public domain). Keep prod hostnames OUT of
// source — derive them from the Vercel-provided env vars, with an explicit
// SERVER_ACTIONS_ALLOWED_ORIGINS escape hatch for any extra brand domains.
const serverActionsAllowedOrigins = [
  "localhost:3000",
  process.env.VERCEL_URL, // this deployment's *.vercel.app host
  process.env.VERCEL_PROJECT_PRODUCTION_URL, // the project's production domain
  ...(process.env.SERVER_ACTIONS_ALLOWED_ORIGINS?.split(",") ?? []),
]
  .map((origin) => origin?.trim())
  .filter((origin) => Boolean(origin) && origin !== "");

// Hono API base — strips trailing slash so the rewrite destination path is clean.
const honoApiBase = (
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"
).replace(/\/$/, "");

/**
 * `standalone` emits `.next/standalone/server.js` with only the modules that
 * server needs, which is what ships to the AWS instance serving
 * app.oxagen.sh. Opt-in rather than the default: `next dev` and every other
 * consumer wants the ordinary output, and only the deploy wants a server
 * bundle.
 *
 * The packages listed in `serverExternalPackages` and aliased in `turbopack`
 * below are NOT bundled into the standalone output — that is what "external"
 * means — so the deploy has to carry a real `node_modules` alongside it. The
 * deploy job builds one with `pnpm deploy --prod`. On Vercel that was covered
 * by the platform running `pnpm install` at the monorepo root beside the
 * function; nothing does that here, and the symptom of getting it wrong is a
 * module-not-found at first request rather than at build.
 */
const isStandalone = process.env.STANDALONE === "1";

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(isStandalone ? { output: "standalone" } : {}),
  // Cache Components (Next 16): opt-in caching via `use cache` + cacheLife/
  // cacheTag, Partial Prerendering by default, and build-time enforcement that
  // every runtime data access (cookies/headers/params/searchParams/uncached IO)
  // sits under a <Suspense> boundary (loading.tsx counts). Route segment
  // configs (`dynamic`, `revalidate`, `fetchCache`) are replaced by this model
  // — do not reintroduce them. See docs/adr/ and
  // https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheComponents
  cacheComponents: true,
  typescript: {
    // Skip the redundant in-build `tsc` pass. Type correctness is gated
    // authoritatively by the CI `checks` job (`pnpm typecheck` →
    // `tsc --noEmit` at an 8GB heap) and by every package's own typecheck.
    // Running tsc a SECOND time inside `next build` (its "Running TypeScript"
    // phase) reserves another ~5GB heap; on the 2-core CI e2e runner — shared
    // with the Postgres/ClickHouse/Neo4j service containers — that pushed the
    // build's RSS past the runner's RAM and got it SIGKILL'd (exit 137) mid
    // typecheck, after an otherwise-successful compile. Dropping the redundant
    // pass reclaims the heap, removes the OOM, and speeds every build (Vercel
    // included) with zero loss of type safety, since the standalone typecheck
    // still fails the PR on any type error.
    ignoreBuildErrors: true,
  },
  // Proxy /api/v1/* requests to the Hono API so browser calls stay same-origin
  // and the Better Auth session cookie is forwarded server-side. Only paths
  // WITHOUT a local App Router handler should fall through to this rewrite.
  //
  // This MUST live in the `fallback` phase, not a bare array. A bare array is
  // treated as `afterFiles`, which Next.js evaluates *before dynamic routes*.
  // That shadowed our dynamic handlers (`/api/v1/conversations/[id]/assets`,
  // `/api/v1/assets/[id]`): the catch-all matched first and proxied them to the
  // Hono API as `/v1/conversations/...`, where the org-scoped router read
  // org="conversations" and 404'd with "Organization not found" — the
  // Conversation Files panel's "HTTP 404". `fallback` runs *after* both static
  // and dynamic filesystem routes, so every local handler (static like
  // `/api/v1/chat/stream` or dynamic like the asset routes) wins, and only
  // genuinely unhandled paths proxy to the API.
  async rewrites() {
    return {
      fallback: [
        {
          source: "/api/v1/:path*",
          destination: `${honoApiBase}/v1/:path*`,
        },
      ],
    };
  },
  reactStrictMode: true,
  transpilePackages: [
    "@oxagen/auth",
    "@oxagen/ai",
    "@oxagen/config",
    "@oxagen/database",
    "@oxagen/oxagen",
    "@oxagen/ui",
  ],
  // Server-only packages with native deps (docker, ssh2) must stay external
  // so webpack doesn't try to bundle their .node binaries into the client.
  serverExternalPackages: [
    "@oxagen/sandbox",
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
  images: {
    // Vercel Blob public URLs (see @oxagen/storage adapter). Scoped to the
    // shared Vercel Blob domain; the single-segment `*` matches the store id so
    // a store rotation doesn't require a config change. Add a brand host here
    // (e.g. "blob.oxagen.ai") only if blobs are ever proxied through it.
    //
    // OAuth-provided avatars (`user.image`) are previewed on the new-org form
    // before they're copied into our blob store on submit:
    //   - Google: lh3–lh6.googleusercontent.com (`*` covers every shard)
    //   - GitHub: avatars.githubusercontent.com (`*` covers it too)
    // Uploaded/ingested avatars are served from Vercel Blob (first pattern).
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
      { protocol: "https", hostname: "*.googleusercontent.com" },
      { protocol: "https", hostname: "*.githubusercontent.com" },
    ],
  },
  experimental: {
    serverActions: { allowedOrigins: serverActionsAllowedOrigins },
  },
  // Ensure webpack doesn't attempt to bundle native addons reached transitively
  // through workspace packages (pnpm workspace:* links resolve to source, so
  // serverExternalPackages alone may not catch transitive native deps).
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        // duckdb and its node-pre-gyp mock deps
        duckdb: "commonjs duckdb",
        "mock-aws-s3": "commonjs mock-aws-s3",
        nock: "commonjs nock",
        "@mapbox/node-pre-gyp": "commonjs @mapbox/node-pre-gyp",
        // Native .node addons
        blake3: "commonjs blake3",
        ssh2: "commonjs ssh2",
        dockerode: "commonjs dockerode",
      });
    }
    return config;
  },
  // Turbopack's NodePreGypConfigReference parser requires `napi_versions` in
  // the `binary` field of package.json. Packages like duckdb and blake3 use
  // the older node-pre-gyp build system and omit that field, causing a fatal
  // parse error even though they're in serverExternalPackages. Aliasing them
  // to a throwing stub prevents Turbopack from ever resolving into these
  // packages. At runtime:
  //   - blake3: dynamic import in @oxagen/engram/hash.ts catches and falls
  //     back to SHA-256
  //   - duckdb: only used server-side via @oxagen/engram store (external)
  turbopack: {
    resolveAlias: {
      blake3: "./src/lib/native-addon-stub.js",
      duckdb: "./src/lib/native-addon-stub.js",
    },
  },
  // Workspace packages use NodeNext-style `import "./foo.js"` from `.ts`
  // source. Turbopack (Next 16 default) maps `.js` import specifiers to the
  // `.ts`/`.tsx` source natively for TypeScript projects — no custom
  // resolveExtensions override (which only *appends* extensions for
  // extensionless imports and suppresses the built-in `.js`→`.ts` remap).
};

export default nextConfig;
