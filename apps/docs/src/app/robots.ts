import type { MetadataRoute } from "next";

/**
 * apps/docs is a public documentation site — the entire point is being found
 * and read, so allow crawling everywhere and point at the sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/" },
    sitemap: "https://docs.oxagen.sh/sitemap.xml",
  };
}
