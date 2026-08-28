# @oxagen/auth

Transport-agnostic identity primitives for Oxagen.

## Overview

This package has two concerns:

1. **Better Auth integration** — the server-side `auth` instance and the
   React client helpers (`authClient`, `signIn`, `signOut`, etc.).
2. **Identity resolvers** — pure functions that resolve session tokens,
   API keys, org slugs, and workspace slugs against the database. These
   functions have no HTTP dependency and are designed to be called
   identically from the API, MCP server, CLI, or tests.

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
Returns `null` if the `better-auth.session_token` cookie is absent or empty.

#### `resolveSession(token: string): Promise<SessionResult | null>`

Resolves a raw session token to `{ userId }`. Returns `null` when the token
is unknown or has expired. Never throws for auth failures.

#### `resolveApiKey(rawKey: string): Promise<ApiKeyResolution>`

Resolves a raw API key (`<prefix>_<secret>` format) to its bound org/workspace
scope. Returns a discriminated union:

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

## Design principles

- **No-drift** — API, MCP, and CLI call the same resolver functions. HTTP
  specifics (cookie header extraction, HTTP status codes) live only in the thin
  adapter layer of each surface (§7.3 thin-wrapper rule).
- **No `any`** — all functions are fully typed.
- **No throws for auth failures** — resolvers return typed discriminated unions.
  Callers decide how to surface errors (HTTP exceptions, MCP error responses,
  CLI stderr, etc.).
- **DB seam** — resolvers call `db()` from `@oxagen/database` directly.
  Tests mock `@oxagen/database` at the module boundary.

## Testing

```sh
pnpm --filter @oxagen/auth test
pnpm --filter @oxagen/auth typecheck
```

Tests cover: valid path, expired token/key, invalid credentials, and
cross-tenant isolation (a user cannot resolve another org's scope).
