import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  webpack: (config) => {
    // fumadocs-mdx loads source files via a dynamic `import(url.href)` that
    // webpack can't statically analyse (the docs dev runs `next dev --webpack`).
    // It's harmless at runtime; silence the build-dependency parse warning.
    config.ignoreWarnings = [
      ...(config.ignoreWarnings ?? []),
      { module: /fumadocs-mdx/, message: /Parsing of .* for build dependencies failed/ },
    ];
    // The warning is emitted by webpack's filesystem cache
    // (PackFileCacheStrategy/FileSystemInfo), which ignoreWarnings does not
    // cover — silence infrastructure logging below warning level.
    config.infrastructureLogging = { ...(config.infrastructureLogging ?? {}), level: "error" };
    // Workspace packages (e.g. @oxagen/ui) consume source and use NodeNext-style
    // `import "./foo.js"` from `.tsx` files; teach webpack to try .ts/.tsx.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default withMDX(nextConfig);
