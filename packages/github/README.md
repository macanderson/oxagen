# @oxagen/github

`@oxagen/github` is the GitHub App client: it mints installation tokens, resolves a workspace's GitHub credential, builds and verifies the App install URLs, and wraps the GitHub REST calls the repository handlers make.

## Boundary

- **Owns:** GitHub App JWT signing and the installation-token cache (`src/app-auth.ts`), the REST client with retry and rate-limit errors (`src/fetch-client.ts`), install and identity URL building with HMAC-signed state (`src/install-url.ts`), per-workspace token resolution (`src/workspace-token.ts`), and the `OXAGEN_PR_LABELS` constant.
- **Does not own:** the GitHub OAuth and webhook HTTP routes (`apps/api/src/routes/v1/github-oauth.ts`, `github-webhook.ts`), the repository capability handlers ([`@oxagen/handlers`](../handlers/README.md)), GitHub record ingestion ([`@oxagen/ingestion`](../ingestion/README.md) connector `src/connectors/github/`), or the `source_connections` and `oauth_accounts` tables ([`@oxagen/database`](../database/README.md)).
- **Depends on:**
  - `@oxagen/database`: `withTenantDb` and the schema, to read a workspace's GitHub connection and stored OAuth token.
  - `@oxagen/crypto`: `decrypt` and the key-id adapter resolver, to open a KMS-wrapped OAuth token.
- **Used by:** `apps/api` and `@oxagen/handlers`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `resolveGitHubToken(ctx)` | export | `packages/github/src/workspace-token.ts` | `packages/handlers/src/lib/github-token.ts` and `packages/handlers/src/lib/run-work-prs.ts` |
| `getInstallationToken`, `createAppInstallationToken`, `revokeInstallationToken` | export | `packages/github/src/app-auth.ts` | `resolveGitHubToken`, `packages/handlers/src/repository.main.bind.ts`, and `packages/handlers/src/tacho.github_token.issue.ts` |
| `createGitHubClient` | export | `packages/github/src/fetch-client.ts` | `packages/handlers/src/repo.ci.status.ts`, `repository.main.bind.ts`, and other repository handlers |
| `mintInstallState`, `verifyInstallState`, `buildInstallAuthUrl` | boundary | `packages/github/src/install-url.ts` | `apps/api/src/routes/v1/github-oauth.ts`, which verifies the signed state on the callback |
| `GitHubWorkspaceScope` | port | `packages/github/src/workspace-token.ts` | Any `CapabilityContext` satisfies it structurally, so this package needs no `@oxagen/oxagen` dependency |

## Entry points

- `.` (`src/index.ts`): the client, App auth, install-URL helpers, types, and `OXAGEN_PR_LABELS`.
- `./workspace-token` (`src/workspace-token.ts`): `resolveGitHubToken`. The barrel does not re-export it, so import this subpath when you need a workspace token.

## Rules

- `resolveGitHubToken` tries three sources in order: a GitHub App installation token, then the workspace's KMS-wrapped OAuth token, then `GITHUB_PERSONAL_ACCESS_TOKEN`. It throws instead of falling back when the caller named a `connectionId` that has no usable credential.
- `GITHUB_PERSONAL_ACCESS_TOKEN` is shared by the whole process. In production it logs a warning on use. ADR-020 limits it to local development, so leave it unset in a deployed environment.
- The installation-token cache keys on host, App, installation, and the requested narrowing (repositories and permissions). A narrowed token never answers a full-installation request, and the reverse holds too.
- `workspace-token.ts` imports `getInstallationToken` from the package barrel, not `./app-auth`, so consumers that mock `@oxagen/github` in tests intercept it. Keep that self-reference.
- ADR-027 sets the multi-tenant GitHub App connect flow and ADR-117 bounds GitHub retries.

## Tests

```bash
pnpm --filter @oxagen/github test:unit src/app-auth.test.ts
```

Never put `--` before the filename. Tests live beside the source in `src/` and in `src/__tests__/`.
