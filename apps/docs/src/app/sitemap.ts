import type { MetadataRoute } from "next";

import { source } from "@/lib/source";

const BASE_URL = "https://docs.oxagen.sh";

/**
 * Walks the same Fumadocs page-tree source that powers
 * apps/docs/src/app/docs/[[...slug]]/page.tsx (source.getPages()), so this
 * sitemap can never list a URL the router doesn't actually serve.
 *
 * No `lastModified`. Reading the clock here would be wrong twice over: Cache
 * Components (`cacheComponents: true` in next.config.mjs) forbids an uncached
 * time read on a prerendered route, and stamping "now" on every entry tells a
 * crawler the whole site changed on every build, which is worse than telling it
 * nothing. `changeFrequency` alone is the honest signal until a real per-page
 * mtime is available from the content source.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const docPages: MetadataRoute.Sitemap = source.getPages().map((page) => ({
    url: `${BASE_URL}${page.url}`,
    changeFrequency: "weekly",
  }));

  return [
    { url: BASE_URL, changeFrequency: "daily" },
    { url: `${BASE_URL}/install`, changeFrequency: "monthly" },
    ...docPages,
  ];
}
