# @oxagen/auth

Transport-agnostic identity primitives for Oxagen: the Better Auth server and client, the resolvers that turn a session cookie or API key into an org and workspace scope, and the PKCE primitives behind `oxagen login`.

## Boundary

- **Owns:** the configured Better Auth instance (`src/auth.ts`) with two-factor, the OAuth proxy, and the SSO plugins (`src/sso/`); the Better Auth route handler with failed sign-in auditing (`src/auth-route.ts`); the browser client (`src/client.ts`); the identity resolvers (`src/resolvers/`); the local-environment predicate (`src/local-env.ts`); and the CLI loopback login codes (`src/cli-auth/`).
- **Does not own:**
  - Authorization after identity is known: [`@oxagen/iam`](../iam/README.md) and the kernel in [`@oxagen/oxagen`](../oxagen/README.md).
  - The identity tables (users, sessions, API keys, rate limits): [`@oxagen/database`](../database/README.md) (`src/schema/auth.ts`, `src/schema/ratelimit.ts`).
  - API key creation and the CLI authorize capability: [`@oxagen/handlers`](../handlers/README.md) (`src/api.key.create.ts`, `src/auth.cli.authorize.ts`).
  - HTTP status mapping, which each surface's thin adapter does (`apps/api/src/middleware/auth.ts`, `apps/mcp/src/context.ts`, `apps/app/src/server/session.ts`).
- **Depends on:**
  - `@oxagen/database`: the Drizzle adapter's connection, `withSystemDb` for resolver reads, security-event emission, and the SSO secret KMS resolver.
  - `@oxagen/crypto`: the KMS adapter that encrypts stored OAuth tokens.
  - `@oxagen/config`: `requireEnv` and `loadEnv` for `BETTER_AUTH_*` settings.
  - `@oxagen/telemetry`: error capture.
  - `@oxagen/notifications`: verification and password-reset email.
  - `@oxagen/billing`: the SSO entitlement check by plan.
  - `@oxagen/oxagen`: trusted client-IP extraction for audited sign-in failures, and the API-key scope purposes the resolvers and CLI codes stamp.
- **Used by:** `apps/api`, `apps/app`, `apps/mcp`, `apps/app_deprecated`, and `@oxagen/handlers`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `handleAuthRequest(request)` | boundary | `packages/auth/src/auth-route.ts` | `apps/app/src/server/session.ts`, reached from `apps/app/src/app/api/auth/[...all]/route.ts`. Emits `auth.sign_in_failed` on a 401, 403, or 429 sign-in |
| `AuthRouteDeps` | port | `packages/auth/src/auth-route.ts` | Tests pass a fake handler and emitter. Production loads `auth.handler` and `emitSecurityEvent` lazily |
| `auth` (Better Auth instance) | export | `packages/auth/src/auth.ts` | `apps/app/src/server/session.ts` via `@oxagen/auth/server` |
| Raw `db()` for the Better Auth adapter | boundary | `packages/auth/src/auth.ts` | The one authorised raw `db()` consumer outside `@oxagen/database`, exempted in `eslint.config.mjs` |
| `resolveSession`, `parseSessionCookie`, `resolveApiKey`, `resolveOrgScope`, `resolveWorkspaceScope` | export | `packages/auth/src/resolvers/` | `apps/api/src/middleware/auth.ts`, `org.ts`, and `workspace.ts`; `apps/mcp/src/context.ts` (`resolveApiKey` only) |
| `createCliAuthCode`, `consumeCliAuthCode`, `verifyPkceS256` | export | `packages/auth/src/cli-auth/index.ts` | `packages/handlers/src/auth.cli.authorize.ts` mints, `apps/api/src/routes/v1/auth.cli.token.ts` redeems |
| `isEmailVerificationRequired` | export | `packages/auth/src/local-env.ts` | `apps/api/src/bootstrap.ts` and `apps/api/src/routes/health.ts` |

## Entry points

- `.` (`src/index.ts`): the resolvers, `auth`, the client helpers, and the local-environment predicate.
- `./server` (`src/auth.ts`): the Better Auth instance alone.
- `./client` (`src/client.ts`): the browser client.
- `./route` (`src/auth-route.ts`): `handleAuthRequest` and the sign-in audit helpers.
- `./cli-auth` (`src/cli-auth/index.ts`): the CLI loopback login primitives.
- `./resolvers` (`src/resolvers/index.ts`): the resolvers without the Better Auth instance.

## Overview

This package has three concerns:

1. **Better Auth integration:** the server-side `auth` instance and the
   React client helpers (`authClient`, `signIn`, `signOut`, etc.).
2. **Identity resolvers:** functions that resolve session tokens, API keys,
   org slugs, and workspace slugs against the database. They have no HTTP
   dependency and are meant to be called the same way from the API, the MCP
   server, the CLI, or a test.
3. **CLI loopback login:** the PKCE authorization-code primitives the app and
   the API share so `oxagen login` can trade a browser approval for an API key
   (`@oxagen/auth/cli-auth`).

## Public surface

### Better Auth (server)

```ts
import { auth } from "@oxagen/auth/server";
```

The fully configured `betterAuth` instance. Only `apps/app` mounts it, at
`/api/auth`, through `@oxagen/auth/route`. The API and MCP servers do not
mount it. They call the resolvers below.

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
as `key_prefix`. It is a fixed leading window, *not* the text before the first
`_`. The secret itself is base64url and can contain `_`, so splitting on the
underscore would match nothing and reject every real key. The full key is then
SHA-256 hashed and compared to the stored hash in constant time.

Returns a discriminated union:

```ts
type ApiKeyResolution =
  | {
      ok: true;
      apiKeyId: string;
      orgId: string;
      workspaceId: string;
      userId: string | null;
    }
  | {
      ok: false;
      kind:
        | "malformed"
        | "invalid"
        | "expired"
        | "purpose_locked"
        | "workspace_archived"
        | "sso_required"
        | "host_revoked";
    };
```

Never throws for auth failures. Callers map `kind` to appropriate errors. The
API answers `sso_required` with 403. It answers `host_revoked`, the retired key
of a Tacho host an operator revoked, with 403 and the reason `host_revoked`,
so the host stops sending. Every other kind is a 401.

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
cut off that user's existing sessions. Those live until they expire (30 days).
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
config actually enforces. Read `src/local-env.ts` before changing either. The
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
port. Only `S256` is accepted, and `plain` is rejected.

## Design principles

- **No drift:** API, MCP, and CLI call the same resolver functions. HTTP
  specifics (cookie header extraction, HTTP status codes) live only in the thin
  adapter layer of each surface (§7.3 thin-wrapper rule).
- **No `any`:** all functions are fully typed.
- **No throws for auth failures:** resolvers return typed discriminated unions.
  Callers decide how to surface errors (HTTP exceptions, MCP error responses,
  CLI stderr, etc.).
- **DB seam:** resolvers read through `withSystemDb` from `@oxagen/database`,
  never raw `db()`. Raw `db()` is banned repo-wide except for the Better Auth
  adapter in `src/auth.ts`, which only touches global auth tables. The system connection is correct
  here and only here: these queries *are* the identity-resolution step, so no
  tenant scope exists yet for them to run inside. Every one of them is annotated
  with a `tenancy: system bypass` comment saying why. Tests mock
  `@oxagen/database` at the module boundary.

## Tests

```bash
pnpm --filter @oxagen/auth test:unit src/resolvers/resolvers.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/`,
`src/resolvers/`, `src/cli-auth/`, and `src/sso/`. CI runs the full suite,
coverage, and typecheck. Do not run them package-wide on the shared machine.

The resolver tests cover the valid path, expired tokens and keys, invalid
credentials, and cross-tenant isolation (a user cannot resolve another org's
scope).
