/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Self-contained benchmark dashboard: no workspace UI packages, no image
  // optimization server. Builds on Turbopack (Next 16 default).
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
