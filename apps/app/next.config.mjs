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

/** @type {import('next').NextConfig} */
const nextConfig = {
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
    remotePatterns: [{ protocol: "https", hostname: "*.public.blob.vercel-storage.com" }],
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
