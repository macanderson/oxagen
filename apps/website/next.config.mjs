/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  typedRoutes: true,
  // Workspace packages (e.g. @oxagen/ui) consume source and use NodeNext-style
  // `import "./foo.js"` from `.tsx` files; teach webpack to try .ts/.tsx when a
  // `.js` import is resolved against package source (mirrors apps/app).
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
