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
  // source. Both Turbopack (Next 16 default) and webpack need to know to
  // try .ts/.tsx when a `.js` import is resolved against package source.
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json"],
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
