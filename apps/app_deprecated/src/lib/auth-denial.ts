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
const REDIRECT_ERROR_CODE = "NEXT_REDIRECT";

/** Read a `digest` string off an unknown thrown value, or null if absent. */
function digestOf(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("digest" in error) ||
    typeof (error as { digest: unknown }).digest !== "string"
  ) {
    return null;
  }
  return (error as { digest: string }).digest;
}

export function isAuthDenialError(error: unknown): boolean {
  const digest = digestOf(error);
  if (digest === null) return false;
  return digest.split(";")[0] === HTTP_ERROR_FALLBACK_ERROR_CODE;
}

/**
 * Map a Next.js access-control fallback error to its HTTP status (404/403/401).
 * Returns null for anything that is not an access-control fallback. The digest
 * format is `NEXT_HTTP_ERROR_FALLBACK;<status>`; an unparseable/absent status
 * defaults to 404 (the only status the resolve-org gates actually emit).
 *
 * Route Handlers (route.ts) have NO not-found render boundary, so a `notFound()`
 * thrown by a resolve-org gate escapes the handler uncaught and crashes the
 * serverless function (FUNCTION_INVOCATION_FAILED → HTTP 502). Catching the
 * fallback and converting it to a real Response is what keeps the route from
 * 502-ing on an unknown org slug / non-manager caller.
 */
export function authDenialStatus(error: unknown): number | null {
  if (!isAuthDenialError(error)) return null;
  const digest = digestOf(error);
  const parsed = Number(digest?.split(";")[1]);
  return Number.isInteger(parsed) ? parsed : 404;
}

/**
 * True when the error is the sentinel thrown by `redirect()` / `permanentRedirect()`
 * from `next/navigation`. Such a throw inside a Route Handler must be re-thrown so
 * Next can turn it into the redirect response — catching it would 500 a valid
 * redirect. (This route uses `NextResponse.redirect`, but a resolve-org helper it
 * calls may `permanentRedirect` on a stale slug.)
 */
export function isNextRedirectError(error: unknown): boolean {
  const digest = digestOf(error);
  if (digest === null) return false;
  return digest.split(";")[0] === REDIRECT_ERROR_CODE;
}
