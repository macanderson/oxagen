/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  experimental: {
    typedRoutes: true,
  },
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json"],
  },
};

export default nextConfig;
