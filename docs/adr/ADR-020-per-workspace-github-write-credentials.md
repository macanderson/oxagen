# ADR-020: Per-workspace GitHub write credentials

**Status:** Accepted (2026-06-28)
**Related:** the GitHub App setup spec (`docs/specs/github-app/github-app-setup.md`)

## Context

The GitHub write capabilities (`repo.create` / `repo.file.put` / `repo.fork` / `repo.branch.create` / `repo.pr.open` / `agent.repo.edit`) currently resolve their token from a single global `GITHUB_PERSONAL_ACCESS_TOKEN` env var (`packages/handlers/src/lib/github-token.ts`) — a dev/demo stub. For real multi-tenant use, each **workspace** must act on GitHub with **its own** credentials.

What already exists (reuse, don't reinvent):
- **`ingestion.source_connections`** — workspace-scoped (`workspaceId`, `orgId`), `connectorId = "github"`, `deliveryConfig` jsonb holding `installationId` / `owner` / `repo` / `defaultBranch`, and `oauthAccountId` FK.
- **`ingestion.oauth_accounts`** — `provider = "github"`, `accessTokenEnc` / `refreshTokenEnc` (KMS envelope `{ keyId, ciphertext }`), `scopes`.
- **The connect flow** (`apps/api/src/routes/v1/github-oauth.ts`) — installs the GitHub App, exchanges the OAuth code, KMS-encrypts the user-to-server token into `oauth_accounts`, links it to `source_connections`, and records `installationId` in `deliveryConfig`.
- **KMS decrypt** — `createIngestionCryptoAdapter()` + `decrypt()`.

What's missing: the App is configured **read-only**; **installation-token minting doesn't exist** (no `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY`); `resolveGitHubToken` doesn't read the per-workspace connection.

## Decision

**Resolve a per-workspace WRITE token via a single resolution chain in `resolveGitHubToken(ctx)`, installation-token-preferred:**

1. **GitHub App installation access token (preferred, production path).** When the workspace's `source_connections` row carries an `installationId` AND the App key is configured, mint a **short-lived** installation token: build an RS256 JWT signed with the App private key (`GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_ID`) and `POST /app/installations/{installationId}/access_tokens`. Cache per installation for ~55 min. Workspace-scoped, repo-granular, bot identity, no long-lived secret stored, high rate limits, revocable by uninstalling.
   - **Implemented with `node:crypto` (RS256) + `fetch` — NOT `@octokit`** — so it stays dependency-light and cannot re-break the Next/Turbopack app bundle (the failure #240 fixed).
2. **Stored per-workspace OAuth token (fallback).** Look up `source_connections` by `(orgId, workspaceId, connectorId="github")`, join `oauth_accounts` via `oauthAccountId`, KMS-decrypt `accessTokenEnc`, return it. Acts as the connecting user. Reuses the existing connect flow + storage + crypto verbatim.
3. **Dev/demo env `GITHUB_PERSONAL_ACCESS_TOKEN` (last resort).** Local only; never the path in a deployed multi-tenant env.

If none resolve, throw a clean, actionable error ("Connect GitHub for this workspace").

### Why this shape
- **Reuses everything** — the workspace connection model, the connect flow, the encrypted store, the KMS adapter — so the only new code is the minter + the resolver chain.
- **Installation tokens are the right production default** (granular, short-lived, org-managed) while the **OAuth fallback** keeps working for connections that predate the App-key rollout, and the **env fallback** keeps local dev frictionless.
- **Per-workspace** by construction: `source_connections` is workspace-scoped; the chosen token derives from that row only.

## Consequences

**Positive**
- Each workspace acts on GitHub as itself; no shared global token in deployed envs.
- Drop-in: the 6 handlers already call `resolveGitHubToken(ctx)` — only the resolver changes.
- Dependency-light minter (node:crypto + fetch) — no bundle risk.

**Negative / external requirements (cannot be done in code — ops/owner actions)**
- **The GitHub App's permissions must include write** (Contents: read+write, Pull requests: read+write, Administration: read+write for repo-create). Today it's read-only; until upgraded, *writes 403 regardless of token type*. Existing installations must re-consent to the new permissions.
- **`GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY` must be set** in the deployed env for path (1). Until then, path (2)/(3) apply.
- These are tracked as a Linear ticket (ops follow-up), referenced from the PR.

**Security**
- Installation tokens are short-lived and never persisted. The OAuth token stays KMS-encrypted at rest; decrypt only at call time within tenant scope (`withTenantDb`/`scopedSession`). The env fallback is gated to non-deployed use.

## Implementation outline
1. `@oxagen/github`: `createAppInstallationToken({ appId, privateKey, installationId, baseUrl? })` — node:crypto RS256 JWT → fetch mint, with an in-process per-installation cache.
2. `packages/config`: add optional `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` to the env schema + registry.
3. `packages/handlers/src/lib/github-token.ts`: implement the chain (installation → OAuth-connection (DB + KMS decrypt) → env), tenant-scoped.
4. Tests: minter (mock fetch + a test RSA key), resolver (mock DB rows + crypto), chain ordering + the no-connection error.
5. Ticket the external GitHub-App-permission upgrade + prod env keys.
