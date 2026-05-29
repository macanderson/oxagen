/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  typedRoutes: true,
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
