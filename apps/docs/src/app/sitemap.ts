import type { MetadataRoute } from "next";

import { source } from "@/lib/source";

const BASE_URL = "https://docs.oxagen.sh";

/**
 * Walks the same Fumadocs page-tree source that powers
 * apps/docs/src/app/docs/[[...slug]]/page.tsx (source.getPages()), so this
 * sitemap can never list a URL the router doesn't actually serve.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
  }));

  return [
    { url: BASE_URL, lastModified: new Date(), changeFrequency: "daily" },
    ...docPages,
  ];
}
