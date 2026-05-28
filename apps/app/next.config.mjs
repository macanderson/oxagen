/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@oxagen/auth", "@oxagen/ai", "@oxagen/config", "@oxagen/database", "@oxagen/oxagen"],
  experimental: {
    serverActions: { allowedOrigins: ["localhost:3000"] },
  },
};

export default nextConfig;
