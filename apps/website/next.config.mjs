/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/ui"],
  typedRoutes: true,
  // Builds on Turbopack (Next 16 default). Workspace packages are consumed as
  // source with extensionless relative imports, resolved natively under
  // `moduleResolution: "Bundler"` — no extension-alias shim needed.
};

export default nextConfig;
