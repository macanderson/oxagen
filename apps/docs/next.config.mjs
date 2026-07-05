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
  // Serve the static HTML sales decks under public/decks/* at clean, extensionless
  // URLs. Vercel resolves a directory's index.html at the clean path in production,
  // but `next dev`/`next start` do not — these rewrites make the exact URLs
  // (e.g. /decks/first-call-enterprise) resolve consistently across every runtime.
  async rewrites() {
    return [
      {
        source: "/decks/first-call-enterprise",
        destination: "/decks/first-call-enterprise/index.html",
      },
      {
        source: "/decks/first-call-enterprise/script",
        destination: "/decks/first-call-enterprise/script.html",
      },
      {
        source: "/decks/architecture-deep-dive",
        destination: "/decks/architecture-deep-dive/index.html",
      },
    ];
  },
};

export default withMDX(nextConfig);
