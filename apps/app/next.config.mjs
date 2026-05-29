/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/auth", "@oxagen/ai", "@oxagen/config", "@oxagen/database", "@oxagen/oxagen"],
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
  // Workspace packages use NodeNext-style `import "./foo.js"` from `.ts`
  // source. Tell webpack to rewrite the .js suffix to .ts/.tsx during
  // resolution so transpilePackages can pull source directly.
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
