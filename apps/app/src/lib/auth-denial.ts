import "server-only";

/**
 * Distinguish a Next.js access-control interrupt (the sentinel thrown by
 * `notFound()` / `forbidden()` / `unauthorized()`) from a genuine runtime
 * error (DB connection refused, timeout, schema mismatch, etc.).
 *
 * The org-membership / role gates in `@/lib/resolve-org` signal authorization
 * failure exclusively via `notFound()`, which throws an `HTTPAccessFallbackError`
 * carrying a `digest` of the form `NEXT_HTTP_ERROR_FALLBACK;<status>`.
 *
 * Server actions wrap `resolveOrg(...)` + `assert*(...)` in a try/catch that
 * maps a denial to `{ ok: false, code: "forbidden" }`. Without this check a
 * bare `catch` also swallows infrastructure failures and reports them as
 * `forbidden` — so an admin sees a permission error during a DB outage, stops
 * retrying, and the outage is invisible in audit trails. Use this to fall
 * through real errors to a logged `internal` result instead.
 *
 * Implemented locally (rather than importing the value from a Next internal
 * path) to keep a stable, testable seam; the digest string is a public,
 * documented contract of `notFound()`.
 */
const HTTP_ERROR_FALLBACK_ERROR_CODE = "NEXT_HTTP_ERROR_FALLBACK";

export function isAuthDenialError(error: unknown): boolean {
  if (
    typeof error !== "object" ||
    error === null ||
    !("digest" in error) ||
    typeof (error as { digest: unknown }).digest !== "string"
  ) {
    return false;
  }
  const digest = (error as { digest: string }).digest;
  const prefix = digest.split(";")[0];
  return prefix === HTTP_ERROR_FALLBACK_ERROR_CODE;
}
