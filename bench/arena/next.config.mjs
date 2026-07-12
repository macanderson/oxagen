/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  // The "@/*" import alias is provided by tsconfig `paths` and is picked up by
  // Turbopack automatically — no `experimental.turbo.resolveAlias` needed (that
  // key is invalid in Next 16 and only emits a config warning).
};

export default nextConfig;
