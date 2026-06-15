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
const honoApiBase = (process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000").replace(/\/$/, "");

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Proxy /api/v1/* requests to the Hono API so browser calls stay same-origin
  // and the Better Auth session cookie is forwarded server-side. Next.js
  // filesystem routes (e.g. /api/v1/chat/stream) take precedence — only paths
  // without a local handler fall through to this rewrite.
  async rewrites() {
    return [
      {
        source: "/api/v1/:path*",
        destination: `${honoApiBase}/v1/:path*`,
      },
    ];
  },
  reactStrictMode: true,
  transpilePackages: ["@oxagen/auth", "@oxagen/ai", "@oxagen/config", "@oxagen/database", "@oxagen/oxagen", "@oxagen/ui"],
  // Server-only packages with native deps (docker, ssh2) must stay external
  // so webpack doesn't try to bundle their .node binaries into the client.
  serverExternalPackages: ["@oxagen/sandbox", "@oxagen/agent", "dockerode", "ssh2"],
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
  // Workspace packages use NodeNext-style `import "./foo.js"` from `.ts`
  // source. Turbopack (Next 16 default) maps `.js` import specifiers to the
  // `.ts`/`.tsx` source natively for TypeScript projects — no custom
  // resolveExtensions override (which only *appends* extensions for
  // extensionless imports and suppresses the built-in `.js`→`.ts` remap).
};

export default nextConfig;
