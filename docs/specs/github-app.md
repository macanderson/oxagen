# GitHub App Setup

Archived spec & plan — status: shipped (audited 2026-07-03).

> **Superseded for launch (2026-07-21).** This archived document preserves the
> pre-pruning implementation record. GitHub now contributes governed provider metadata;
> the exact code graph stays local, and source text, symbols, chunks, imports, and code
> embeddings are not ingested centrally. Canonical protected/default-ref topology and a
> typed evidence ledger are follow-ups. The historical body below is not a current
> implementation contract.

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The GitHub App Setup feature is fully shipped and operational. All core deliverables are implemented: OAuth authentication flow (auth-url and callback routes), webhook receiver for live sync, Inngest-based initial file sync, database schema for storing connections and OAuth accounts, environment variable configuration, and customer-facing setup UI. The implementation spans API routes, database migrations, Inngest functions, app landing pages, and comprehensive documentation.

**Implementation evidence**

- /Users/macanderson/Workspaces/oxagen-platform/apps/api/src/routes/v1/github-oauth.ts — OAuth auth-url (line 332) and callback routes fully implemented
- /Users/macanderson/Workspaces/oxagen-platform/apps/api/src/routes/v1/github-webhook.ts — App-level webhook receiver for GitHub events
- /Users/macanderson/Workspaces/oxagen-platform/apps/api/src/app.ts — all three GitHub routes mounted (webhook at line 256, OAuth routes at lines 499 & 546)
- /Users/macanderson/Workspaces/oxagen-platform/packages/ingestion/src/connectors/github/index.ts — GitHub connector definition with connectorId='github', deliveryMethod='webhook'
- /Users/macanderson/Workspaces/oxagen-platform/packages/inngest-functions/src/functions/ingestion.github-initial-sync.ts — event handler for initial file sync
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/github/setup/page.tsx — Setup URL landing route for post-install redirect
- /Users/macanderson/Workspaces/oxagen-platform/packages/database/atlas/migrations/20260611233016_initial_schema.sql — database tables ingestion.oauth_accounts and ingestion.source_connections with proper status constraints
- /Users/macanderson/Workspaces/oxagen-platform/packages/config/src/env.ts and registry.ts — all four GitHub App environment variables defined
- /Users/macanderson/Workspaces/oxagen-platform/packages/handlers/src/connection.mappings.set.ts — mappings handler triggers ingestion/github.initial-sync on connection activation (line 218)
- /Users/macanderson/Workspaces/oxagen-platform/apps/docs/content/docs/connections/github.mdx — customer-facing setup documentation
- /Users/macanderson/Workspaces/oxagen-platform/docs/specs/github-app/github-app-setup.md — operational setup guide (spec file itself)

**Source documents** (archived verbatim below)

- `docs/specs/github-app/github-app-setup.md`

## Document — `github-app-setup.md`

## GitHub App setup — source-code ingestion connector

**Audience:** operators / platform engineers configuring the GitHub connector.
**Last verified against code:** 2026-06-28.

This document is the authoritative setup reference for the GitHub App(s) that power the
**source-code ingestion connector**. It lists every configuration value, the exact callback
and webhook endpoints the code expects, the permissions and events to subscribe to, and which
values differ between **development** and **production**.

For the customer-facing "how do I connect my repo" walkthrough, see
`apps/docs/content/docs/connections/github.mdx`.

---

### TL;DR

| Decision | Answer |
| --- | --- |
| One GitHub App or two? | **Two.** One for dev/localhost, one for production. See [Why two apps](#why-two-separate-apps). |
| What kind of credential? | A **GitHub App** (not an OAuth App). The flow calls `/user/installations`, which only exists for GitHub Apps. |
| What grants repo access today? | The App's **permissions** + the **user-to-server OAuth token**. The App private key / App ID are **not** used yet (no installation tokens). |
| OAuth callback URL | `{NEXT_PUBLIC_API_URL}/oauth/github/callback` |
| Webhook URL | App-level `{NEXT_PUBLIC_API_URL}/webhooks/github/app` — **live**. See [Webhooks](#webhooks). |
| Setup URL | Optional. Recommended → app sources page, with **Redirect on update** ON. See [Setup URL](#setup-url-post-install-redirect). |

---

### How source code is ingested (the live path)

The connector is defined in `packages/ingestion/src/connectors/github/index.ts`
(`connectorId: "github"`, `deliveryMethod: "webhook"`, auth schemes
`oauth2_authorization_code` / `api_key`). There are **two ingestion paths**: a one-time
**pull-based initial sync** that backfills the repo's file tree (below), and **live webhooks** that
stream subsequent changes ([Webhooks](#webhooks)). Both run on the user's OAuth token today:

1. **Create connection.** The app creates a `ingestion.source_connections` row in
   `status = "pending_setup"`.
2. **Build the authorize URL.**
   `GET /v1/{org_slug}/{workspace_slug}/connections/github/auth-url?connectionId={con_...}`
   (`apps/api/src/routes/v1/github-oauth.ts:71`) returns a signed
   `https://github.com/login/oauth/authorize?...` URL with:
   - `client_id = GITHUB_APP_CLIENT_ID`
   - `scope = repo,read:org` *(see note below — ignored for GitHub Apps)*
   - `redirect_uri = {NEXT_PUBLIC_API_URL}/oauth/github/callback`
   - `state = base64url(json).hmac` signed with `GITHUB_APP_INSTALL_STATE_SECRET`, 10-minute TTL.
3. **User authorizes** on GitHub.
4. **Callback.** `GET /oauth/github/callback?code=&state=`
   (`github-oauth.ts:363`, mounted at `apps/api/src/app.ts:283`) verifies the state HMAC
   (constant-time), exchanges the `code` at `https://github.com/login/oauth/access_token`,
   **envelope-encrypts** the access + refresh tokens (`@oxagen/crypto`, AES-256-GCM), upserts
   `ingestion.oauth_accounts` (unique on `org_id, provider, provider_user_id`), links it to the
   connection, and **302-redirects** to:
   `{NEXT_PUBLIC_APP_URL}/{org_slug}/{ws_slug}/knowledge/sources?setup=github&connectionId={con_...}`.
5. **Pick an installation + repo.**
   `GET .../connections/github/installations` →
   `GET .../connections/github/installations/{installationId}/repositories`
   (both decrypt the stored user token and call the GitHub REST API).
6. **Activate + sync.** Saving the repo selection calls `connection.mappings.set` with
   `activateConnection: true` (`packages/handlers/src/connection.mappings.set.ts:98`), which fires
   the `ingestion/github.initial-sync` Inngest event using `deliveryConfig.{owner, repo, defaultBranch}`.
7. **Initial sync.** `ingestion.github-initial-sync`
   (`packages/inngest-functions/src/functions/ingestion.github-initial-sync.ts`) decrypts the user
   token, calls `GET /repos/{owner}/{repo}/git/trees/{branch}?recursive=1`, filters to source
   blobs (extensions `.ts/.tsx/.py`, `size > 0`, skipping `node_modules/`, `dist/`, `.git/`,
   `__pycache__/`, capped at 500 files), upserts a `:SourceConnection` node in Neo4j, and fans out
   `ingestion/github.parse-file` events. The shared pipeline
   (`ingestion.pipeline.ts`, event `ingestion/entity.received`) normalizes → dedups → upserts
   `:EntityNode`s with embeddings, following the dual-write pattern of
   [ADR-012](../adr/ADR-012-connector-dual-write-pattern.md) (Postgres = durable cursor/health,
   Neo4j = graph index).

> **Note on `scope`.** The authorize URL passes `scope=repo,read:org`, but **GitHub Apps ignore the
> `scope` parameter** — a user-to-server token's access is governed entirely by the App's configured
> **permissions** and which installations/repos the user can reach. Set the permissions below
> correctly; the `scope` value is a harmless vestige.

> **Note on tokens.** Ingestion runs on the **user's** OAuth token, not an installation access
> token (the App private key/App ID are never read). This is simpler but means sync is tied to the
> authorizing user's continued access. Migrating to installation tokens (JWT signed with the App
> private key → installation access token) is a recommended future hardening — see
> [Known gaps](#known-gaps--follow-ups).

---

### Why two separate apps

Create **two** GitHub Apps and keep their credentials in separate environments:

| App | Used by | API origin (`NEXT_PUBLIC_API_URL`) | App origin (`NEXT_PUBLIC_APP_URL`) |
| --- | --- | --- | --- |
| **Oxagen (Dev)** | localhost + Vercel preview | `http://localhost:4000` | `http://localhost:3000` |
| **Oxagen** | production | `https://api.oxagen.sh` | `https://app.oxagen.sh` |

Reasons:

1. **A GitHub App has a single global webhook URL.** Dev must point at a public tunnel
   (smee.io / cloudflared) or a preview URL; prod points at the Vercel API. One App cannot serve both.
2. **Secret isolation (SOC 2).** A leaked dev client secret / webhook secret / state secret must
   never grant access to production data.
3. **Blast-radius separation.** Re-generating the dev App's secret or rotating its private key must
   not disrupt production ingestion.

GitHub Apps *do* allow up to 10 callback URLs, so callbacks alone could be shared — but the
single webhook URL and secret-isolation reasons make two apps the correct choice.

---

### GitHub App configuration

Create each App at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
(or under an organization's settings to own it at the org level).

#### Identity

| Field | Dev | Prod |
| --- | --- | --- |
| **GitHub App name** | `Oxagen (Dev)` | `Oxagen` |
| **Homepage URL** | `http://localhost:3000` | `https://app.oxagen.sh` |
| **Description** | Source-code & repo-activity ingestion for the Oxagen knowledge graph. | same |

#### Identifying and authorizing users (OAuth)

| Field | Dev | Prod |
| --- | --- | --- |
| **Callback URL** | `http://localhost:4000/oauth/github/callback` | `https://api.oxagen.sh/oauth/github/callback` |
| **Request user authorization (OAuth) during installation** | ✅ recommended | ✅ recommended |
| **Enable Device Flow** | ❌ off | ❌ off |
| **Expire user authorization tokens** | ❌ off (recommended) | ❌ off (recommended) |

- The **Callback URL** must exactly match `{NEXT_PUBLIC_API_URL}/oauth/github/callback`. Localhost
  is valid here because the *browser* performs the redirect (GitHub's servers don't call it).
- **Expire user authorization tokens — leave OFF for now.** The callback stores a `refresh_token`
  when present, but there is **no token-refresh job wired yet**. Non-expiring user tokens avoid
  silent sync failures until refresh is implemented. (Revisit when installation tokens land.)
- Enabling **OAuth during installation** lets a GitHub-initiated install run the OAuth handshake in
  one hop, returning both `code` and `installation_id` to the callback.

#### Setup URL (post-install redirect)

The **Setup URL** is where GitHub sends users *after they install or reconfigure the App from
GitHub's own UI* (it receives `installation_id` and `setup_action=install|update`). It is **distinct
from the OAuth Callback URL**.

| Field | Dev | Prod |
| --- | --- | --- |
| **Setup URL** | `http://localhost:3000/github/setup` | `https://app.oxagen.sh/github/setup` |
| **Redirect on update** | ✅ on | ✅ on |

**Recommendation: set a Setup URL and enable "Redirect on update".** The exact path matters — set it
to **`/github/setup`** (the implemented landing route, `apps/app/src/app/github/setup/page.tsx`), not
`/connections/github/setup` (which does not exist and would 404).

- It guarantees that a user who installs the App directly from GitHub (rather than starting inside
  Oxagen) lands back in the product to finish wiring the connection.
- **Redirect on update = ON** brings the user back whenever they add/remove repositories from the
  installation, so Oxagen can reconcile the repo selection. **This leg is the common case for the
  in-app connect flow too**: when the App is ALREADY installed, GitHub treats a subsequent connect as
  an installation *update* and uses this stateless Setup URL (carrying `installation_id` +
  `setup_action`, NO OAuth `state`) — NOT the OAuth callback. The `/github/setup` route resolves the
  user's workspace and the wizard recovers the in-progress connection from a sessionStorage handoff,
  so the wizard resumes Step 2 instead of restarting. If this URL is wrong/blank, that resume breaks.
- **The first-ever install** (App not yet installed) goes through the OAuth callback
  (`/oauth/github/callback`) instead, which round-trips our signed `state` and redirects straight to
  `…/knowledge/sources?setup=github&connectionId=…`.

#### Permissions

These are what actually grant the connector access (the OAuth `scope` is ignored for GitHub Apps).

**Repository permissions:**

| Permission | Access | Why |
| --- | --- | --- |
| **Contents** | Read-only | Read the repo tree + file blobs — **required for source ingestion**. |
| **Metadata** | Read-only | Mandatory (auto-selected); repo names, default branch, languages. |
| **Pull requests** | Read-only | Ingest PRs (`pull_request` record type). |
| **Issues** | Read-only | Ingest issues + issue comments. |
| **Commit statuses** | Read-only *(optional)* | Useful if status/check context is ingested later. |

**Organization permissions:**

| Permission | Access | Why |
| --- | --- | --- |
| **Members** | Read-only *(optional)* | Resolve author/org membership; only needed if you map GitHub users to org members. |

Keep everything **read-only** — the connector never writes to GitHub.

#### Where can this App be installed?

- **Dev:** "Only on this account" is fine.
- **Prod:** "Any account" if customers will install it into their own orgs; "Only on this account"
  if it is internal-only for now.

---

### Webhooks

Continuous sync is **live**. GitHub delivers every event for every installation to the App's single
global webhook URL; Oxagen verifies the signature, resolves the affected connection(s) from the
payload, and fires the same ingestion pipeline the initial sync uses.

**Route:** `POST {NEXT_PUBLIC_API_URL}/webhooks/github/app`
(`apps/api/src/routes/v1/github-webhook.ts`, mounted at `apps/api/src/app.ts` **before** the generic
`/webhooks` route so the static path isn't captured as `connectorId=github, connectionId=app`).

How it works:

1. **Verify** the raw body's `x-hub-signature-256` (HMAC-SHA256, constant-time) against the App's
   single webhook secret `GITHUB_APP_WEBHOOK_SECRET`. Missing secret → **503**; bad signature → **401**.
2. **Lifecycle** events (`ping`, `installation`, `installation_repositories`) are acked. On
   `installation` `deleted`/`suspend`, the matching connections are set to `paused`.
3. **Resolve** target connection(s): `connector_id = 'github'`, `status = 'connected'`, matching
   `delivery_config->>'installationId'` and `delivery_config.owner/repo` against the payload's
   `repository.full_name`.
4. **Extract** ingestable records via the connector's `parseWebhookEvent()`, which both translates
   GitHub's event name to the connector's record type and unwraps the payload (e.g. `issues` →
   `issue` from `payload.issue`; a `push` fans out to one `commit` per commit, reshaped for
   `normalizeRecord`).
5. **Fan out** one `ingestion/entity.received` per (connection × record). The 6-step pipeline then
   maps/dedups/embeds — exactly as the initial sync does.

> **Mapping still governs ingestion.** A webhook record is only persisted if the connection has an
> `entity_type_mappings` row for that record type (created via `connection.mappings.set`). Unmapped
> record types are received and skipped by design — map the types you want to ingest continuously.

#### Webhook config on the App

| Field | Dev | Prod |
| --- | --- | --- |
| **Active** | ✅ | ✅ |
| **Webhook URL** | `https://{your-tunnel}/webhooks/github/app` | `https://api.oxagen.sh/webhooks/github/app` |
| **Secret** | value of `GITHUB_APP_WEBHOOK_SECRET` (dev) | value of `GITHUB_APP_WEBHOOK_SECRET` (prod) |
| **SSL verification** | Enable | Enable |

**Subscribe to events** (each maps to a connector record type handled by `parseWebhookEvent`):

| GitHub event | Feeds record type |
| --- | --- |
| `push` | `commit` (one per commit) |
| `pull_request` | `pull_request` |
| `pull_request_review` | `code_review` |
| `pull_request_review_comment` | `comment` |
| `issues` | `issue` |
| `issue_comment` | `comment` |
| `release` | `release` |
| `repository` | `repository` |

`installation` and `installation_repositories` are delivered automatically (no subscription needed)
and drive the pause-on-uninstall reconciliation.

> **Dev webhooks need a public tunnel.** GitHub cannot reach `localhost`. Use smee.io,
> `cloudflared tunnel`, or `ngrok` and set the dev App's Webhook URL to the tunnel origin
> forwarding to `http://localhost:4000`.

---

### Environment variables

All GitHub connector variables live in the **`api`** service (read in `apps/api`). Schema:
`packages/config/src/env.ts:38-45`; registry: `packages/config/src/registry.ts:315-351`.

> ⚠️ **Local dev: put these in `apps/api/.env.local`, not the repo-root `.env.local`.** `apps/api`
> loads its env via `tsx --env-file`, which is CWD-relative — `GITHUB_APP_*` placed only in the root
> `.env.local` silently no-op and the connector returns 503. (This exact gap bit the connector once.)

| Variable | Secret | Required where | Dev value (`apps/api/.env.local`) | Prod value (`oxagen-v2-api` on Vercel) |
| --- | --- | --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | no | api | Dev App → Client ID | Prod App → Client ID |
| `GITHUB_APP_CLIENT_SECRET` | yes | api | Dev App → generated client secret | Prod App → generated client secret |
| `GITHUB_APP_WEBHOOK_SECRET` | yes | api (required for webhooks) | Dev App webhook secret | Prod App webhook secret |
| `GITHUB_APP_INSTALL_STATE_SECRET` | yes | api | `openssl rand -hex 32` (dev value) | `openssl rand -hex 32` (distinct prod value) |
| `NEXT_PUBLIC_API_URL` | no | all | `http://localhost:4000` | `https://api.oxagen.sh` |
| `NEXT_PUBLIC_APP_URL` | no | all | `http://localhost:3000` | `https://app.oxagen.sh` |
| `INGESTION_CRYPTO_PROVIDER` | no | optional | `env` | `env` (or `kms`) |
| `INGESTION_ENCRYPTION_KEY` | yes | preview/prod | `openssl rand -base64 32` | required — wraps OAuth token encryption |
| `AUTH_TOKEN_ENCRYPTION_KEY` | yes | preview/prod | blank ok locally | required (auth startup guard) |

Notes:

- **`GITHUB_APP_INSTALL_STATE_SECRET`** signs the OAuth `state` param (CSRF/replay protection).
  Use a **different** value per environment.
- **`INGESTION_ENCRYPTION_KEY`** is the master key that envelope-encrypts the stored GitHub
  access/refresh tokens. If it's wrong or rotated without re-encryption, stored tokens become
  undecryptable and sync fails.
- The GitHub App **private key (.pem)** and **App ID** are **not** consumed by current code — do not
  add them to env until installation-token auth is implemented.

#### Setting prod values

Set the four `GITHUB_APP_*` vars on the **`oxagen-v2-api`** Vercel project across the
environments it serves (production + preview if the dev App also covers preview). Datastore/auth
vars (`INGESTION_ENCRYPTION_KEY`, `AUTH_TOKEN_ENCRYPTION_KEY`) are team-shared — confirm they're
present before first use.

---

### Verification checklist

After configuring an App and its env vars:

1. **Config presence:** `pnpm env:check` passes; `GITHUB_APP_CLIENT_ID` /
   `GITHUB_APP_INSTALL_STATE_SECRET` resolve (the `auth-url` route returns **503** if either is missing).
2. **Authorize URL:** `GET /v1/{org}/{ws}/connections/github/auth-url?connectionId=con_...` returns a
   `https://github.com/login/oauth/authorize?...` URL whose `redirect_uri` is
   `{NEXT_PUBLIC_API_URL}/oauth/github/callback` and matches the App's Callback URL exactly.
3. **Round-trip:** complete the browser flow; confirm a row in `ingestion.oauth_accounts`
   (`provider = 'github'`, non-null `access_token_enc`) and that the connection links to it.
4. **Installations/repos:** `.../connections/github/installations` and `.../repositories` return
   data (not 404/502).
5. **Sync:** activate a repo; confirm `ingestion/github.initial-sync` fired (API logs:
   `"connection.mappings.set: fired ingestion/github.initial-sync"`), the connection moves to
   `status = 'connected'`, and `:EntityNode`s appear in Neo4j for the repo.
6. **Webhook:** with the App's webhook pointed at `/webhooks/github/app`, push a commit (or open a
   PR) to a connected repo; confirm a 2xx delivery in the App's **Advanced → Recent Deliveries** and
   an `ingestion/entity.received` event in Inngest. (Records persist only for mapped record types.)

---

### Known gaps / follow-ups

Resolved in code (kept here for history):

- ✅ **App-level webhook receiver** — `POST /webhooks/github/app` resolves connections from the
  payload's `installation.id` + `repository.full_name`.
- ✅ **`GITHUB_APP_WEBHOOK_SECRET` wired** — used for HMAC verification on the App-level route.
- ✅ **Event-name → record-type mapping** — `github.parseWebhookEvent()` translates and unwraps each
  event (incl. `push` → per-commit fan-out).
- ✅ **`installation` / `installation_repositories` handling** — acked; uninstall/suspend pauses the
  installation's connections.
- ✅ **Status-constraint bug** — activation now writes `connected` (was the invalid `active`, which
  violated `source_connections_status_check`).
- ✅ **Setup URL landing route** — implemented at **`/github/setup`**
  (`apps/app/src/app/github/setup/page.tsx`); resolves the membership-gated workspace and the wizard
  recovers the in-progress connection via a sessionStorage handoff so it resumes Step 2 (not Step 1).
  `/installations` + `/repositories` fall back to (and link) the org's GitHub OAuth account when the
  Setup-URL "update" leg left the connection unlinked.

Still open — worth tracking in Linear (`oxagen-v2`, labels `connectors`, `ingestion`):

1. **Installation-token auth** — move unattended sync off the user token onto GitHub App installation
   access tokens (JWT signed with the App private key), so sync survives the authorizing user leaving.
2. **Webhook receipt bookkeeping** — optionally stamp `last_sync_at` / a `webhook_subscriptions`
   row on delivery for observability (functional sync does not require it).
3. **`push` → `source` file ingestion** — webhook `push` currently ingests commits; ingesting the
   changed *files* (added/modified/removed) as `source` records on push is a follow-up. Initial
   sync still covers the full file tree.
