/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/auth", "@oxagen/ai", "@oxagen/config", "@oxagen/database", "@oxagen/oxagen", "@oxagen/ui"],
  // Server-only packages with native deps (docker, ssh2) must stay external
  // so webpack doesn't try to bundle their .node binaries into the client.
  serverExternalPackages: ["@oxagen/sandbox", "@oxagen/agent", "dockerode", "ssh2"],
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
  // Workspace packages use NodeNext-style `import "./foo.js"` from `.ts`
  // source. Turbopack (Next 16 default) maps `.js` import specifiers to the
  // `.ts`/`.tsx` source natively for TypeScript projects — no custom
  // resolveExtensions override (which only *appends* extensions for
  // extensionless imports and suppresses the built-in `.js`→`.ts` remap).
};

export default nextConfig;
