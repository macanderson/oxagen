/**
 * Documentation site base URL — dynamic, durable, and NOT required to boot the app.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_DOCS_URL` (explicit override) — always wins, any environment.
 *   2. `NODE_ENV === "development"` → the local docs dev server (apps/docs runs on :3300).
 *   3. otherwise (production / preview) → `https://docs.oxagen.sh`.
 *
 * The override is optional: with no env var set the app still resolves a correct
 * URL in every environment. Safe in both Server Components and `"use client"`
 * code because `NODE_ENV` and `NEXT_PUBLIC_*` are inlined by Next at build time.
 */
const PROD_DOCS_URL = "https://docs.oxagen.sh";
const DEV_DOCS_URL = "http://localhost:3300";

/** The docs site origin, with any trailing slash stripped. */
export function getDocsBaseUrl(): string {
  const override = process.env.NEXT_PUBLIC_DOCS_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") return DEV_DOCS_URL;
  return PROD_DOCS_URL;
}

/**
 * Build an absolute docs URL for a path.
 * @example docsUrl("/plugins/registries") // -> "https://docs.oxagen.sh/plugins/registries"
 */
export function docsUrl(path = ""): string {
  const base = getDocsBaseUrl();
  if (!path) return base;
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
