import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
/**
 * `standalone` emits `.next/standalone/server.js` with only the modules the
 * server actually loads, which is what makes this shippable to a small
 * instance without copying the whole dependency tree. Gated on an environment
 * variable so local development and other targets are unaffected.
 */
const isStandalone = process.env.STANDALONE === "1";

const nextConfig = {
  ...(isStandalone ? { output: "standalone" } : {}),
  // Cache Components (Next 16): `use cache` + cacheLife/cacheTag with Partial
  // Prerendering as the default. The docs site is fully static (MDX +
  // generateStaticParams), so pages prerender into the static shell; the model
  // enforces at build time that any future runtime data access is explicitly
  // wrapped in <Suspense> or cached.
  cacheComponents: true,
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  // Builds on Turbopack (Next 16 default); fumadocs-mdx integrates via
  // createMDX(). Workspace packages are consumed as source with extensionless
  // relative imports, resolved natively under `moduleResolution: "Bundler"`.
  images: {
    unoptimized: true,
  },
  // Stella's documentation moved to its own site; permanent redirects keep the
  // old docs.oxagen.sh URLs from 404ing. The target site's paths differ from
  // the old /docs/stella/* structure, so deep links land on its docs root.
  async redirects() {
    return [
      {
        source: "/stella",
        destination: "https://stella.oxagen.sh",
        permanent: true,
      },
      {
        source: "/docs/stella",
        destination: "https://stella.oxagen.sh/docs",
        permanent: true,
      },
      {
        source: "/docs/stella/:path*",
        destination: "https://stella.oxagen.sh/docs",
        permanent: true,
      },
    ];
  },
  // Serve the static HTML sales decks under public/decks/* at clean, extensionless
  // URLs. Vercel resolves a directory's index.html at the clean path in production,
  // but `next dev`/`next start` do not — these rewrites make the exact URLs
  // (e.g. /decks/first-call-enterprise) resolve consistently across every runtime.
  async rewrites() {
    return [
      {
        source: "/decks",
        destination: "/decks/index.html",
      },
      {
        source: "/decks/investor",
        destination: "/decks/investor/index.html",
      },
      {
        source: "/decks/roadmap",
        destination: "/decks/roadmap/index.html",
      },
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
      {
        source: "/decks/unpoisonable-edits",
        destination: "/decks/unpoisonable-edits/index.html",
      },
      {
        source: "/decks/mutation-verifier",
        destination: "/decks/mutation-verifier/index.html",
      },
      {
        source: "/decks/verified-outcome-router",
        destination: "/decks/verified-outcome-router/index.html",
      },
      {
        source: "/decks/agentic-cli-roadmap",
        destination: "/decks/agentic-cli-roadmap/index.html",
      },
    ];
  },
};

export default withMDX(nextConfig);
