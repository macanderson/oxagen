# @oxagen/auth

Transport-agnostic identity primitives for Oxagen.

## Overview

This package has three concerns:

1. **Better Auth integration** — the server-side `auth` instance and the
   React client helpers (`authClient`, `signIn`, `signOut`, etc.).
2. **Identity resolvers** — functions that resolve session tokens, API keys,
   org slugs, and workspace slugs against the database. They have no HTTP
   dependency and are meant to be called the same way from the API, the MCP
   server, the CLI, or a test.
3. **CLI loopback login** — the PKCE authorization-code primitives the app and
   the API share so `oxagen login` can trade a browser approval for an API key
   (`@oxagen/auth/cli-auth`).

## Public surface

### Better Auth (server)

```ts
import { auth } from "@oxagen/auth/server";
```

The fully configured `betterAuth` instance. Mount at `/api/auth` in each
HTTP surface.

### Better Auth (client)

```ts
import { authClient, signIn, signOut, signUp, useSession, getSession } from "@oxagen/auth/client";
```

React / browser client. Uses `window.location.origin` on the browser and
`BETTER_AUTH_URL` on the server.

### Identity resolvers

All resolvers are exported from the package root:

```ts
import {
  parseSessionCookie,
  resolveSession,
  resolveApiKey,
  resolveOrgScope,
  resolveWorkspaceScope,
} from "@oxagen/auth";
```

#### `parseSessionCookie(cookieHeader: string | undefined): string | null`

Extracts the Better Auth session token from a raw `Cookie` header value.

The cookie is **not** the Better Auth default name. `auth.ts` sets
`advanced.cookiePrefix = "oxagen"`, so the cookie is `oxagen.session_token`
(exported as `SESSION_COOKIE_NAME`). In production, secure cookies are on, and
the browser sends it as `__Secure-oxagen.session_token`; the parser accepts the
bare name and the `__Secure-` / `__Host-` prefixed names. Hardcoding the bare
name in a caller 401s every browser request in production while passing locally.

The cookie value is signed as `<token>.<base64 HMAC>`. `parseSessionCookie`
URL-decodes it and calls `stripCookieSignature` so the returned string matches
the raw `sessions.token` column. It returns `null` if no session cookie is
present or its value is empty.

#### `resolveSession(token: string): Promise<SessionResult | null>`

Resolves a raw session token to `{ userId }`. Returns `null` when the token
is unknown or has expired. Never throws for auth failures.

#### `resolveApiKey(rawKey: string): Promise<ApiKeyResolution>`

Resolves a raw API key to its bound org/workspace scope.

A raw key looks like `ox_<base64url secret>`. The lookup prefix is the **first
12 characters** of the whole key (`API_KEY_PREFIX_LENGTH`), stored and indexed
as `key_prefix` — it is a fixed leading window, *not* the text before the first
`_`. The secret itself is base64url and can contain `_`, so splitting on the
underscore would match nothing and reject every real key. The full key is then
SHA-256 hashed and compared to the stored hash in constant time.

Returns a discriminated union:

```ts
type ApiKeyResolution =
  | { ok: true; apiKeyId: string; orgId: string; workspaceId: string }
  | { ok: false; kind: "malformed" | "invalid" | "expired" };
```

Never throws for auth failures — callers map `kind` to appropriate errors.

#### `resolveOrgScope(userId: string, slug: string): Promise<OrgScopeResolution>`

Resolves an org slug to `{ orgId }`, enforcing that `userId` is a member of
the org. Both a missing org and non-membership return `not_found` to prevent
org-existence enumeration.

```ts
type OrgScopeResolution =
  | { ok: true; orgId: string }
  | { ok: false; kind: "not_found" };
```

#### `resolveWorkspaceScope(orgId: string, slug: string, userId?: string | null): Promise<WorkspaceScopeResolution>`

Resolves a workspace slug within a confirmed org to `{ workspaceId }`. The
lookup is always scoped to the provided `orgId` via the composite unique index
`(org_id, slug)`, so a slug that exists in another org returns `not_found`.
When `userId` is given, it also checks that the user is a member of the
workspace and returns `not_member` if not.

```ts
type WorkspaceScopeResolution =
  | { ok: true; workspaceId: string }
  | { ok: false; kind: "not_found" | "not_member" };
```

#### What the resolvers do *not* check

`resolveSession` answers one question: does this token map to a session row
that has not expired? It does **not** look at the user's `status` column or at
`users.deleted_at`. So suspending or soft-deleting a user does not by itself
cut off that user's existing sessions — those live until they expire (30 days).
Anything that needs "is this account still allowed in" must check the user row
itself, or the session must be revoked at the same time the account is
suspended.

### Environment predicate

```ts
import { isEmailVerificationRequired, resolveIsLocalEnv } from "@oxagen/auth";
```

`resolveIsLocalEnv` decides whether this process is a developer machine or the
E2E harness, as opposed to a deployed environment. That one answer gates every
security relaxation in `auth.ts`: email verification, the mandatory OAuth
token-encryption key, secure cookies, and the OAuth proxy.
`isEmailVerificationRequired` is the same predicate, inverted, for callers such
as the API `/health` check that need to report the condition the running auth
config actually enforces. Read `src/local-env.ts` before changing either — the
comments there explain why `NODE_ENV` alone is not trustworthy at module-load
time.

### CLI loopback login

```ts
import {
  createCliAuthCode,
  consumeCliAuthCode,
  verifyPkceS256,
  isLoopbackRedirectUri,
} from "@oxagen/auth/cli-auth";
```

The server-side half of the CLI's browser login (RFC 8252 loopback redirect +
RFC 7636 PKCE). The app mints a single-use code bound to an org/workspace and
the CLI's PKCE challenge; the API redeems it for a real API key. Redemption is
an atomic delete-returning, so a code cannot be replayed, and codes may only
ever be returned to a `127.0.0.1` / `localhost` / `::1` URL with an explicit
port. Only `S256` is accepted — `plain` is rejected.

## Design principles

- **No-drift** — API, MCP, and CLI call the same resolver functions. HTTP
  specifics (cookie header extraction, HTTP status codes) live only in the thin
  adapter layer of each surface (§7.3 thin-wrapper rule).
- **No `any`** — all functions are fully typed.
- **No throws for auth failures** — resolvers return typed discriminated unions.
  Callers decide how to surface errors (HTTP exceptions, MCP error responses,
  CLI stderr, etc.).
- **DB seam** — resolvers read through `withSystemDb` from `@oxagen/database`,
  never raw `db()` (which is banned repo-wide). The system connection is correct
  here and only here: these queries *are* the identity-resolution step, so no
  tenant scope exists yet for them to run inside. Every one of them is annotated
  with a `tenancy: system bypass` comment saying why. Tests mock
  `@oxagen/database` at the module boundary.

## Testing

```sh
pnpm --filter @oxagen/auth test:unit
pnpm --filter @oxagen/auth test:coverage
pnpm --filter @oxagen/auth typecheck
```

Tests cover: valid path, expired token/key, invalid credentials, and
cross-tenant isolation (a user cannot resolve another org's scope).
