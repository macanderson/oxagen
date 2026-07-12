# GitHub MCP Server — OAuth Enablement (Operator Runbook)

**Status:** Active
**Date:** 2026-07-11
**Related:** `packages/plugins/src/oauth/preregistered-clients.ts`, `apps/app/src/app/api/v1/mcp/oauth/authorize/route.ts`, `docs/specs/google-oauth-clients.md`

## Goal

Let Oxagen customers connect the **remote GitHub MCP server**
(`https://api.githubcopilot.com/mcp/`) from Workbench → Agent Tools → MCP
Servers and sign in with OAuth — no personal access token, no per-customer
setup.

## Why this needs a one-time platform setup (the whole story)

GitHub's remote MCP server does **not** support OAuth 2.0 **Dynamic Client
Registration** (DCR / RFC 7591). Verified against the live endpoints:

| Probe | Result |
|---|---|
| Unauth `POST /mcp/` | `401` + `WWW-Authenticate: Bearer ... resource_metadata="https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/"` |
| Protected-resource metadata | `authorization_servers: ["https://github.com/login/oauth"]`, scopes: `repo, read:org, read:user, user:email, ...` |
| AS metadata (RFC 8414, path-aware) `https://github.com/.well-known/oauth-authorization-server/login/oauth` | has `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported: ["S256"]` (PKCE ✓), `grant_types_supported: [..., "refresh_token"]` (refresh ✓), **no `registration_endpoint`** (DCR ✗) |

Oxagen's OAuth-for-MCP flow (`DbOAuthClientProvider` + MCP SDK `auth()`) tries
DCR by default. Against GitHub the SDK throws
`"does not support dynamic client registration"`, which the authorize route
(`classifyAuthError`) maps to reason `dcr_unsupported`. That is the
"platform administrator must configure a pre-registered OAuth client" error.

The escape hatch is already coded: `DbOAuthClientProvider.clientInformation()`
consults `MCP_OAUTH_PREREGISTERED_CLIENTS` **before** attempting DCR
(`packages/plugins/src/oauth/preregistered-clients.ts`). Supply a pre-registered
client for `api.githubcopilot.com` and the rest of the PKCE + refresh flow
proceeds unchanged. **No code change is required to enable GitHub — only the two
operator steps below.**

## Decision: OAuth App, not GitHub App

Use a classic **GitHub OAuth App** for the MCP connection (this is a different
concern from the data-connector **GitHub App** in
`ADR-027-multi-tenant-github-app-connect.md` — keep the two apps separate).

Rationale, specific to this endpoint:

- GitHub's MCP resource metadata advertises **classic OAuth scopes** (`repo`,
  `read:org`, …). **OAuth Apps honor** the `scope` the MCP SDK requests; GitHub
  Apps ignore `scope` (their permissions come from App config + installation).
- GitHub Apps require a separate **per-org installation** step before user
  tokens grant repo access. Oxagen's `authorize` → `callback` flow has **no
  installation handling** — going GitHub App would mean building that first.
- The pre-registered-client escape hatch expects a single `client_id` /
  `client_secret` pair — exactly an OAuth App's shape.

Revisit a GitHub App only if per-repo governance through this MCP endpoint later
becomes a requirement (it would be net-new installation-flow work).

## Step 1 — Register the Oxagen GitHub OAuth App (GitHub UI, one-time)

1. Go to **https://github.com/settings/developers → OAuth Apps → New OAuth App**
   (register under an org GitHub account for shared ownership, not a personal one).
2. **Application name:** `Oxagen` (this string is shown to customers on GitHub's
   consent screen — it becomes "Authorize Oxagen").
3. **Homepage URL:** `https://app.oxagen.sh`
4. **Authorization callback URL:** `https://app.oxagen.sh/api/v1/mcp/oauth/callback`
   - GitHub OAuth Apps allow **multiple** callback URLs on one app. Add the dev
     callback too: `http://localhost:3000/api/v1/mcp/oauth/callback`.
   - Preview deployments: GitHub OAuth Apps allow only one callback **host**, so
     PR-preview hostnames won't match. If MCP-OAuth on previews is ever needed,
     mirror the Better Auth OAuth-Proxy pattern used for social login
     (`docs/specs/google-oauth-clients.md`, Client A) — do not register N
     preview hosts.
5. **Enable Device Flow:** leave **off** (not used here).
6. Click **Register application**, then **Generate a new client secret**.
7. Copy the **Client ID** and **Client Secret**.

## Step 2 — Configure Oxagen (env var, per environment)

Set `MCP_OAUTH_PREREGISTERED_CLIENTS` — a JSON object keyed by the MCP server's
endpoint **host** (lowercase, no scheme):

```
MCP_OAUTH_PREREGISTERED_CLIENTS={"api.githubcopilot.com":{"client_id":"<CLIENT_ID>","client_secret":"<CLIENT_SECRET>"}}
```

- **Production/preview:** set it as a secret in Vercel for the `app` service (the
  authorize/callback routes run in `apps/app`). The var is already declared in
  `packages/config/src/env.ts` and `registry.ts` (`secret: true`,
  `services: ["api", "app"]`) — no schema change needed.
- **Local dev:** add the same line to `.env.local` (the key already appears
  empty in `.env.example:121`). Use a **separate** OAuth App whose callback is
  `http://localhost:3000/api/v1/mcp/oauth/callback`, or add localhost as a second
  callback on the one app.
- The value is a secret (contains the client secret) — never commit it; rotate
  if it's ever pasted into chat or a ticket.

To add more DCR-less providers later, add more host keys to the same object.

## What the customer does (after Steps 1–2)

1. Workbench → Agent Tools → **MCP Servers** → **Connect a custom MCP server**.
2. Name: `GitHub`; Endpoint URL: `https://api.githubcopilot.com/mcp/`;
   Transport: **Streamable HTTP**; Authentication: **OAuth** (or **No
   authentication** — the install-time probe auto-upgrades it to OAuth on the
   `401`).
3. On install the server shows **Needs authentication** → click **Authenticate**
   → GitHub consent screen ("Authorize Oxagen") → back to Oxagen showing
   **Connected**.

A curated one-click **catalog** tile for GitHub is deliberately **out of scope**
here: the catalog is DB-backed and synced from external MCP registries, and
GitHub's official remote server is not listed in any of them
(`https://registry.modelcontextprotocol.io` returns only third-party
GitHub-related servers). Adding a featured/curated-server surface is a separate
follow-up; the custom-connect form above already works end-to-end.

## Verifying it works

- **Endpoint + token sanity (no Oxagen needed):**
  ```
  curl -sS -X POST https://api.githubcopilot.com/mcp/ \
    -H "Authorization: Bearer <a user token>" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_me","arguments":{}}}'
  ```
  A `200` with a `get_me` result confirms the endpoint accepts bearer tokens.
- **Full flow (local):** with Step 2 set in `.env.local`, run `pnpm dev`, connect
  GitHub via the form, click Authenticate, complete GitHub consent, and confirm
  the server lands on **Connected** (credential status `active`).

## Failure-mode reference

| Symptom | Cause | Fix |
|---|---|---|
| Toast: "GitHub isn't available for OAuth sign-in yet … contact Oxagen support" | `MCP_OAUTH_PREREGISTERED_CLIENTS` has no entry for `api.githubcopilot.com` in this environment | Do Steps 1–2 for that environment. The authorize route logs the exact host + remedy server-side (search logs for `does not support dynamic client registration`). |
| GitHub consent screen 404 / redirect_uri mismatch | Callback URL on the OAuth App doesn't match the environment's origin | Ensure the app lists `<origin>/api/v1/mcp/oauth/callback` for this environment |
| Connects but tools 401 later | User token expired and refresh failed | Refresh is supported (AS advertises `refresh_token`); check the oauth-refresh watcher logs |
