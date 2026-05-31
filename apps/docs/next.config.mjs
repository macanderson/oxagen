import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  turbopack: {
    resolveExtensions: [".ts", ".tsx", ".mts", ".mjs", ".js", ".jsx", ".json"],
  },
};

export default withMDX(nextConfig);
