/**
 * The app's own public origin — dynamic, durable, and NOT required to boot.
 *
 * Resolution order (the same shape as docs-url.ts):
 *   1. `NEXT_PUBLIC_APP_URL` (explicit override) — always wins, any environment.
 *   2. `NODE_ENV === "development"` → the local dev server on :3000.
 *   3. otherwise (production / preview) → `https://app.oxagen.sh`.
 *
 * Next resolves relative `openGraph` / `twitter` image URLs against
 * `metadataBase`, and without one it falls back to `http://localhost:3000`
 * — which is what production served in its <meta property="og:image"> until
 * the root layout passed this origin in. `NEXT_PUBLIC_*` and `NODE_ENV` are
 * inlined at build, so this is safe in Server Components and client code.
 */
const PROD_APP_URL = "https://app.oxagen.sh";
const DEV_APP_URL = "http://localhost:3000";

/** The app origin, with any trailing slash stripped. */
export function getAppBaseUrl(): string {
  const override = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (process.env.NODE_ENV === "development") return DEV_APP_URL;
  return PROD_APP_URL;
}

/**
 * The origin as a URL for `metadata.metadataBase`. An override that is not a
 * URL (a stray quote, a bare hostname) falls back to the environment default
 * rather than failing every render of the root layout.
 */
export function getMetadataBase(): URL {
  try {
    return new URL(getAppBaseUrl());
  } catch {
    return new URL(
      process.env.NODE_ENV === "development" ? DEV_APP_URL : PROD_APP_URL,
    );
  }
}
