import type { MetadataRoute } from "next";

/**
 * apps/app is an authed dashboard shell (every route requires a session) —
 * explicitly disallow crawling rather than relying on the *absence* of a
 * robots file, which some crawlers/tools treat as "everything is allowed".
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", disallow: "/" },
  };
}
