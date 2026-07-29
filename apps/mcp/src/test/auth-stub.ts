// Test stub for the `@oxagen/auth` package. The auth barrel
// (packages/auth/src/index.ts) re-exports `./auth`, whose module top-level
// calls requireEnv([BETTER_AUTH_SECRET, BETTER_AUTH_URL, GOOGLE_LOGIN_*,
// GITHUB_LOGIN_*, ...]). With those env vars unset (as in CI / local unit
// runs) importing the barrel THROWS at collection time, so any mcp test that
// transitively imports it (schema / tool-registry tests → ../context →
// `resolveApiKey` from "@oxagen/auth") fails to even collect.
//
// mcp only consumes `resolveApiKey` from this package (apps/mcp/src/context.ts),
// and it is invoked exclusively inside request handlers — never at import time
// and never in the schema/registry unit tests. So aliasing the whole package to
// this no-op stub is safe: it removes the eager env side effect without
// weakening the real auth kernel. context.test.ts additionally `vi.mock`s
// "@oxagen/auth", which takes precedence over this alias, so that suite is
// unaffected. Mirrors apps/app/src/test/server-only-stub.ts.
export function resolveApiKey(): never {
  throw new Error(
    "@oxagen/auth is stubbed in mcp unit tests; resolveApiKey must be vi.mock()'d in any test that exercises it (see apps/mcp/src/context.test.ts).",
  );
}
