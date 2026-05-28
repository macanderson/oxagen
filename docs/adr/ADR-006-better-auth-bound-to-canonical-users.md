# ADR-006 — Better Auth bound to canonical `auth.users`

**Date:** 2026-05-27
**Status:** Accepted
**Epic:** Foundations

## Context

The platform owns its user model (`auth.users` with mixins, soft
delete, audit) per spec §6.2. The auth provider must integrate with
that schema rather than maintain a parallel user store.

## Decision

Use **Better Auth** with its Drizzle adapter pointed at the canonical
`auth.users` table. Sessions, accounts, and verification tokens live
in `auth.sessions`, `auth.accounts`, `auth.verifications` (Better
Auth's required tables) under the same `auth` schema.

## Alternatives considered

- **Clerk.** Faster to ship but users live in Clerk's data plane;
  syncing them back to `auth.users` adds latency and a sync surface.
  Loses control over the data model.
- **Auth.js / NextAuth.** Solid, but the Drizzle adapter story is
  weaker than Better Auth's, and the framework-specific bindings
  (`next-auth/react`) tie auth to Next.js. Not ideal for `apps/api`
  and `apps/mcp` which also need session validation.
- **Roll our own.** Auth is the most security-sensitive surface in the
  stack; "roll our own" is the wrong default.

## Consequences

- `packages/auth/src/auth.ts` configures Better Auth with Drizzle
  adapter, email/password + Google + GitHub providers.
- Field mapping: our schema uses `display_name`/`avatar_url`/
  `email_verified_at` rather than Better Auth defaults — remap in
  config.
- Sessions read on the server only (RSC + server actions); client
  components never see tokens.
- `auth.api_keys` is **not** Better Auth managed — it's first-party
  machine-auth for `apps/api` and `apps/mcp`.
- OAuth providers configured conditionally based on env var presence.
