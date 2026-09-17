// The app's own public origin. Pure and edge-safe (§2): `NEXT_PUBLIC_*` and
// `NODE_ENV` are inlined at build, so it reads the same wherever it is called.
//
// Next resolves a relative `openGraph` / `twitter` image URL against
// `metadata.metadataBase`, and with no base it falls back to
// `http://localhost:3000` — which is what production advertised as its
// `og:image` until the root layout passed this origin in (#3076, #3091).

/** Where the app is served when nothing says otherwise. */
const PROD_APP_URL = "https://app.oxagen.sh";
const DEV_APP_URL = "http://localhost:3000";

/**
 * The app origin, with any trailing slash stripped. Internal: `getMetadataBase`
 * is the one thing that needs it, and an exported second spelling of the origin
 * is a second place for it to drift.
 *
 * Resolution order:
 *   1. `NEXT_PUBLIC_APP_URL` — an explicit override wins in any environment.
 *   2. `NODE_ENV === "development"` → the local dev server on :3000.
 *   3. otherwise (production, preview, test) → `https://app.oxagen.sh`.
 */
function appBaseUrl(): string {
  const override = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (override !== undefined && override !== "")
    return override.replace(/\/+$/, "");
  return process.env.NODE_ENV === "development" ? DEV_APP_URL : PROD_APP_URL;
}

/**
 * The origin as a `URL` for `metadata.metadataBase`.
 *
 * An override that is not a URL — a stray quote, a bare hostname — falls back
 * to the environment default rather than throwing out of `generateMetadata`
 * and failing every render of the root layout.
 */
export function getMetadataBase(): URL {
  try {
    return new URL(appBaseUrl());
  } catch {
    return new URL(
      process.env.NODE_ENV === "development" ? DEV_APP_URL : PROD_APP_URL,
    );
  }
}
