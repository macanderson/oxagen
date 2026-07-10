# ADR-027: Multi-tenant GitHub App connect (identity leg + installation registry)

- **Status:** Accepted
- **Date:** 2026-07-09
- **Supersedes/relates:** ADR-020 (per-workspace GitHub write credentials — installation-token resolution order)

## Context

A GitHub App **installation** is a singleton per GitHub account: `installation_id`
is globally unique and belongs to the GitHub org/user, not to whichever Oxagen
tenant first connected it. Many Oxagen tenants and workspaces legitimately share
one installation — the App webhook already fans events out cross-tenant by
`installationId`.

The original connector flow defined *connected* as **"the Oxagen org has an
`ingestion.oauth_accounts` row"**, and that row was only ever written from a
fresh OAuth `code`. GitHub issues that `code` only on the **first** install of
the App on an account; once the App is already installed, GitHub degrades to the
stateless **Setup-URL "update"** redirect, which carries no `code` and no signed
`state`. Consequence: a **second** Oxagen tenant (a different org/workspace whose
user is a member of the same GitHub org) could never create its `oauth_accounts`
row and was permanently stuck at "not connected."

Installation identity + lifecycle had **no home**: `installation_id` lived only
inside `source_connections.delivery_config` JSONB with no uniqueness, and the
webhook derived affected connections by scanning that JSONB.

## Decision

1. **Identity leg is the primary Connect.** Drive "Connect GitHub" through
   `login/oauth/authorize` (user-to-server authorization), NOT `installations/new`.
   It **always** returns a fresh `code` and echoes our signed `state`, whether or
   not the App is already installed — so the existing `oauth_accounts` upsert
   fires for any tenant. `installations/new` is retained as a secondary "Install
   on another org / change repo access" affordance (`/auth-url?mode=install`).

2. **Installation registry.** A platform-scoped `ingestion.github_installations`
   table (UNIQUE on `installation_id`) is the source of truth for installation
   identity + lifecycle. It is deliberately **not** tenant-scoped — like
   `ingestion.connector_schemas` it is a shared/system catalog (no
   `org_id`/`workspace_id`, no RLS, `oxagen_app` grants only). The App webhook
   maintains it (created/unsuspend → reactivate; suspend/deleted → record +
   pause connections); the callback and listings keep it fresh from the user's
   authoritative view.

3. **Authorization gate.** Because the server holds `GITHUB_APP_PRIVATE_KEY`, any
   workspace that writes a valid `installationId` onto a connection can mint an
   installation token (ADR-020) and read that org's private repos — regardless of
   the acting user's GitHub access. So a **client-supplied** `installationId` is
   only trusted after `assertGithubInstallationAccessible` confirms it appears in
   the acting user's `GET /user/installations` (GitHub is the authorization
   oracle). Enforced on every untrusted write path
   (`connection.mappings.set` / `create` / `update`); **fail-closed**. The
   install/OAuth callback is exempt — its `installationId` arrives via GitHub's
   HMAC-verified redirect, not client input.

4. **Ingestion stays installation-token-first** (ADR-020). The user OAuth token
   is used for identity, the interactive installations/repos picker, and the
   attach authorization check; it is **not** an ongoing dependency for sync — so
   ingestion survives a user leaving the org or revoking their token.

## Consequences

- A second tenant can attach to an already-installed GitHub org without
  re-installing: Connect (identity) → `/user/installations` shows the org → pick
  + bind (gated) → sync via installation token.
- The registry removes the fragile `delivery_config ->> 'installationId'` JSONB
  derivation of installation identity and gives lifecycle a home.
- The Setup-URL no-match landing routes to `settings/github` (Connect/attach),
  not the repo picker, which assumed a token and dead-ended.
- Requires `GITHUB_APP_CLIENT_ID` in the API env (already required by the
  existing OAuth callback, so no new secret).

## Verification note

GitHub's real already-installed redirect behavior must be validated against a
prod-equivalent environment (two Oxagen orgs, one shared GitHub org) — it cannot
be exercised from a dev box.
