import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  // Builds on Turbopack (Next 16 default); fumadocs-mdx integrates via
  // createMDX(). Workspace packages are consumed as source with extensionless
  // relative imports, resolved natively under `moduleResolution: "Bundler"`.
  images: {
    unoptimized: true,
  },
};

export default withMDX(nextConfig);
