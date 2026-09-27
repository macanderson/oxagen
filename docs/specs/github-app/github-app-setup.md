# GitHub App setup

**Audience:** operators / platform engineers configuring the GitHub connector.
**Last verified against code:** 2026-06-28.

This document is the setup reference for the two GitHub Apps Oxagen uses. For each app, it lists
every configuration value, the callback and webhook endpoints the code expects, the permissions
and events to subscribe to, and the values that differ between **development** and **production**.

| App | What it acts on | Sections |
| --- | --- | --- |
| **Oxagen** | Your code repositories. It feeds the **provider-metadata connector** and opens governed pull requests. | [TL;DR](#tldr) through [Verification checklist](#verification-checklist) |
| **Oxagen Steering** | Steering repos only. It creates each one and holds its settings. | [Oxagen Steering](#oxagen-steering) |

Register each app twice, once for development and once for production, for reasons 2 and 3 in
[Why two separate apps](#why-two-separate-apps).

> **Launch boundary (2026-07-21):** the connector ingests repository, ref, commit,
> pull-request, issue, release, and workflow metadata. It does not ingest repository
> source text, symbols, chunks, imports, or code embeddings. Exact code graphs stay
> local. Canonical protected/default-ref topology and typed run evidence are follow-ups.

For the customer-facing "how do I connect my repo" walkthrough, see
`apps/docs/content/docs/connections/github.mdx`.

---

## TL;DR

| Decision | Answer |
| --- | --- |
| How many GitHub Apps? | **Two, each registered twice.** Oxagen and Oxagen Steering, each with a dev copy and a production copy. See [Why two apps](#why-two-separate-apps) and [Oxagen Steering](#oxagen-steering). |
| What kind of credential? | A **GitHub App** (not an OAuth App). The flow calls `/user/installations`, which only exists for GitHub Apps. |
| What grants repo access today? | Ingestion runs on the **user-to-server OAuth token**, limited by the App's **permissions**. Governed pull requests use an installation token minted with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and fall back to the user token (`packages/github/src/workspace-token.ts`). |
| Steering repos | **Oxagen Steering**, a second app with Administration and Deployments write. See [Oxagen Steering](#oxagen-steering). |
| OAuth callback URL | `{NEXT_PUBLIC_API_URL}/oauth/github/callback` |
| Webhook URL | App-level `{NEXT_PUBLIC_API_URL}/webhooks/github/app` — **live**. See [Webhooks](#webhooks). |
| Setup URL | Optional. Recommended → app sources page, with **Redirect on update** ON. See [Setup URL](#setup-url-post-install-redirect). |

---

## How GitHub metadata is ingested (the live path)

The connector is defined in `packages/ingestion/src/connectors/github/index.ts`
(`connectorId: "github"`, `deliveryMethod: "webhook"`, auth schemes
`oauth2_authorization_code` / `api_key`). There are **two ingestion paths**: a one-time
**pull-based initial sync** that backfills repository and delivery metadata, and **live webhooks**
that stream subsequent changes ([Webhooks](#webhooks)). Both run on the user's OAuth token today:

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
   token, resolves the repository and its actual default branch, and backfills bounded repository,
   pull-request, issue, release, and commit metadata. It upserts the `:SourceConnection` metadata
   node and sends provider records through `ingestion/entity.received`; the shared pipeline
   normalizes, deduplicates, and projects those governed records into Neo4j. No repository tree or
   source blob is parsed or embedded server-side.

> **Note on `scope`.** The authorize URL passes `scope=repo,read:org`, but **GitHub Apps ignore the
> `scope` parameter** — a user-to-server token's access is governed entirely by the App's configured
> **permissions** and which installations/repos the user can reach. Set the permissions below;
> the `scope` value has no effect.

> **Note on tokens.** Ingestion runs on the **user's** OAuth token, not an installation access
> token (ingestion never reads the App private key or App ID). This is simpler but means sync is tied to the
> authorizing user's continued access. Migrating to installation tokens (JWT signed with the App
> private key → installation access token) is a recommended future hardening — see
> [Known gaps](#known-gaps--follow-ups).

---

## Why two separate apps

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

GitHub Apps *do* allow up to 10 callback URLs, so callbacks alone could be shared; the
single webhook URL and secret isolation still require two apps.

---

## GitHub App configuration

Create each App at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**
(or under an organization's settings to own it at the org level).

### Identity

| Field | Dev | Prod |
| --- | --- | --- |
| **GitHub App name** | `Oxagen (Dev)` | `Oxagen` |
| **Homepage URL** | `http://localhost:3000` | `https://app.oxagen.sh` |
| **Description** | Source-code & repo-activity ingestion for the Oxagen knowledge graph. | same |

### Identifying and authorizing users (OAuth)

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

### Setup URL (post-install redirect)

The **Setup URL** is where GitHub sends users *after they install or reconfigure the App from
GitHub's own UI* (it receives `installation_id` and `setup_action=install|update`). It is **distinct
from the OAuth Callback URL**.

| Field | Dev | Prod |
| --- | --- | --- |
| **Setup URL** | `http://localhost:3000/github/setup` | `https://app.oxagen.sh/github/setup` |
| **Redirect on update** | ✅ on | ✅ on |

**Recommendation: set a Setup URL and enable "Redirect on update".** Set it
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

### Permissions

These grant the connector access (the OAuth `scope` is ignored for GitHub Apps).

**Repository permissions:**

| Permission | Access | Why |
| --- | --- | --- |
| **Contents** | Read **and write** | Read the repo tree + file blobs for source ingestion, and write the branch and the file every governed pull request carries. |
| **Metadata** | Read-only | Mandatory (auto-selected); repo names, default branch, languages. |
| **Pull requests** | Read **and write** | Ingest PRs (`pull_request` record type), and open, re-read and close the pull requests that carry a skill, an agent definition, a context record or a tool. |
| **Checks** | Write | Report each governed-file check as a check run on the head commit, and run the CI tasks a governed pull request needs. |
| **Issues** | Read-only | Ingest issues + issue comments. |
| **Commit statuses** | Read-only *(optional)* | Useful if status/check context is ingested later. |

**Organization permissions:**

| Permission | Access | Why |
| --- | --- | --- |
| **Members** | Read-only *(optional)* | Resolve author/org membership; only needed if you map GitHub users to org members. |

**This App is read-write** (decided 2026-09-18, on #3242). Earlier revisions of this document said
to keep every permission read-only because "the connector never writes to GitHub". That was true of
the ingestion connector and was never true of the product around it: `packages/github/src/workspace-token.ts`
mints installation tokens, and `packages/handlers/src/context.pr.open.ts` has been creating branches,
committing files, opening pull requests and reporting check runs with them since ADR-061. A read-only
permission set cannot open a pull request, so the documented set described something the code had
already outgrown.

What the write access does **not** buy, and what no permission here should be read as granting:
Oxagen writes to a branch and never to the production branch; it opens and closes pull requests but
merges only what a person merges, under the governance mode the repository itself declares
(`.oxagen/rules/governance.toml`); and nothing it writes can grant a tool, raise a tier or lift a
budget. See `docs/specs/repository-binding/README.md`.

### Where can this App be installed?

- **Dev:** "Only on this account" is fine.
- **Prod:** "Any account" if customers will install it into their own orgs; "Only on this account"
  if it is internal-only for now.

---

## Webhooks

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
   maps/dedups/embeds, as the initial sync does.

> **Mapping still governs ingestion.** A webhook record is only persisted if the connection has an
> `entity_type_mappings` row for that record type (created via `connection.mappings.set`). Unmapped
> record types are received and skipped by design — map the types you want to ingest continuously.

### Webhook config on the App

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

## Environment variables

Most GitHub connector variables live in the **`api`** service (read in `apps/api`). The
**Required where** column names the others. Schema: `packages/config/src/env.ts`. Registry:
`packages/config/src/registry.ts`.

> ⚠️ **Local dev: put these in `apps/api/.env.local`, not the repo-root `.env.local`.** `apps/api`
> loads its env via `tsx --env-file`, which is CWD-relative — `GITHUB_APP_*` placed only in the root
> `.env.local` silently no-op and the connector returns 503. (This gap has broken the connector before.)

| Variable | Secret | Required where | Dev value (`apps/api/.env.local`) | Prod value (`oxagen-v2-api` on Vercel) |
| --- | --- | --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | no | api | Dev App → Client ID | Prod App → Client ID |
| `GITHUB_APP_CLIENT_SECRET` | yes | api | Dev App → generated client secret | Prod App → generated client secret |
| `GITHUB_APP_WEBHOOK_SECRET` | yes | api (required for webhooks) | Dev App webhook secret | Prod App webhook secret |
| `GITHUB_APP_INSTALL_STATE_SECRET` | yes | api | `openssl rand -hex 32` (dev value) | `openssl rand -hex 32` (distinct prod value) |
| `GITHUB_APP_ID` | no | api, app, mcp (installation tokens) | Dev App → App ID | Prod App → App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | api, app, mcp (installation tokens) | Dev App → generated private key (PEM) | Prod App → generated private key (PEM) |
| `GITHUB_APP_SLUG` | no | api, app, mcp (optional) | Dev App → public slug | Prod App → public slug |
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
- **`GITHUB_APP_ID`** and **`GITHUB_APP_PRIVATE_KEY`** go together. With both set,
  `resolveGitHubToken()` (`packages/github/src/workspace-token.ts`) mints an installation token for
  a workspace connection that carries an installation id. With either unset, it falls back to the
  connecting user's OAuth token.
- **`GITHUB_APP_SLUG`** is the path segment in `https://github.com/apps/<slug>`. Oxagen uses it to
  link you to GitHub's install and configure page. When it is unset, the connection dialog reads
  the slug from an existing installation.

### Setting prod values

Set the `GITHUB_APP_*` vars on the **`oxagen-v2-api`** Vercel project across the
environments it serves (production + preview if the dev App also covers preview). Datastore/auth
vars (`INGESTION_ENCRYPTION_KEY`, `AUTH_TOKEN_ENCRYPTION_KEY`) are team-shared — confirm they're
present before first use.

---

## Verification checklist

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

## Oxagen Steering

Oxagen Steering is the GitHub App Oxagen uses on steering repos and nowhere else. A steering repo
holds steering records. Each workspace gets a private repository named `oxagen-<workspace-slug>`,
and the organization gets `<org>/oxagen`. The Oxagen app keeps the permissions in
[Permissions](#permissions). Nothing in this section changes them.

### Reason for a separate app

Administration write lets an app create repositories and change their settings. Oxagen Steering
needs it to create and configure steering repos. Keeping it off the Oxagen app means an
installation on your code repositories never holds it.

### Provisioning steps

The durable job `steering-repo/provision` (`packages/handlers/src/steering_repo.provision.ts`) runs
these steps. An Oxagen Steering installation token makes every change on GitHub except the one in step 2.
Every step is safe to repeat, and a rerun adopts what an earlier run made.

1. It creates the repository in your GitHub organization. When the name is taken, it tries `-2`,
   `-3`, and so on.
2. It adds the repository to the installation with the owner's user token. See
   [Installation](#installation).
3. It writes the first commit to `main`.
4. It applies the prescribed settings (`packages/oxagen/src/steering-repo/settings-baseline.ts`) and
   reads them back:
   - The `Oxagen steering` ruleset on `main` requires the `Oxagen steering` status check, pinned to
     the Oxagen Steering app so no one else can post it. It has no bypass actors.
   - The `Oxagen merges` ruleset on `main` restricts updates. Its only bypass actor is Oxagen
     Steering, so every steering PR reaches `main` through Oxagen.
   - Squash merges only, and head branches deleted after a merge.
   - Actions off.
   - The `steering` environment, which accepts deployments from `main` only.
5. It records version 1 as a deployment to the `steering` environment.
6. For a workspace repo, it binds the repository to the workspace with role `steering`.

### Added permissions

Oxagen Steering holds every repository and organization permission in
[Permissions](#permissions), at the same access. It adds two repository permissions:

| Permission | Access | Why |
| --- | --- | --- |
| **Administration** | Read and write | Create the steering repo in the organization, apply its rulesets and merge settings, turn Actions off, and create the `steering` environment. |
| **Deployments** | Read and write | Record each published version as a deployment to the `steering` environment. |

### Installation

An organization owner installs Oxagen Steering on your GitHub organization. With **Request user
authorization (OAuth) during installation** on, the install also authorizes that owner. Onboarding
stores the owner's user-to-server token in `ingestion.oauth_accounts` with
`provider = 'github_steering'`.

Onboarding starts the connect at
`GET /v1/{org_slug}/connections/steering/github?app=steering&mode=install|authorize&return_to=<path>`
(`apps/api/src/routes/v1/github-oauth.ts`). Only an organization Owner or Admin may call it.
`mode=install` sends the owner to the app's `installations/new` page. `mode=authorize` sends them to
`login/oauth/authorize`, for an owner whose organization already has the app installed: GitHub
returns a code from an install only the first time. Both carry a signed state with purpose
`steering`, and GitHub returns to the app's Callback URL, `GET /oauth/github/steering`. That route
exchanges the code with the app's client ID and secret, stores the token, and sends the provision
event again for each scope that waits on a connection. It then redirects to `return_to` with
`steering=connected`, or with `steering=error&code=<reason>` when a step after the state check
fails. The same start route with `app=oxagen&mode=install` installs the Oxagen app and binds no
repository.

Provisioning reads the owner's installations with that token (`GET /user/installations`) and makes
one change with it: `PUT /user/installations/{installation_id}/repositories/{repository_id}`. That
call adds the new repository to an installation limited to selected repositories. The endpoint
takes a user token, so an installation token cannot make it. An installation on all repositories
already covers the new repository, so provisioning skips the call.

When no token is stored, or GitHub answers 401, 403, or 404, provisioning stops at the
`add_to_installation` step with `steering_reauthorize`. Oxagen raises a banner that asks an
organization owner to authorize Oxagen Steering again. A retry starts from that step.

### Webhook subscriptions

Provisioning needs no webhook. Leave **Active** off under **Webhook**, and subscribe to no events.

### Configuration

Set five variables on the **`api`** service, where the connect routes and the provisioning job
run. `steeringAppFromEnv()` in `packages/handlers/src/steering_repo.provision.ts` reads the App ID,
the private key and the slug. When any of those is unset, or the App ID is not a positive integer,
provisioning stops with `steering_app_unconfigured`. The connect routes read all five and
`GITHUB_APP_INSTALL_STATE_SECRET`, which signs the connect's state. When one is unset, the connect
answers 503 with `steering_app_unconfigured` and names the variable.

| Variable | Secret | Required where | Dev value (`apps/api/.env.local`) | Prod value (`oxagen-v2-api` on Vercel) |
| --- | --- | --- | --- | --- |
| `OXAGEN_STEERING_APP_ID` | no | api (steering provisioning) | Dev Steering App → App ID | Prod Steering App → App ID |
| `OXAGEN_STEERING_APP_CLIENT_ID` | no | api (steering connect) | Dev Steering App → Client ID | Prod Steering App → Client ID |
| `OXAGEN_STEERING_APP_CLIENT_SECRET` | yes | api (steering connect) | Dev Steering App → generated client secret | Prod Steering App → generated client secret |
| `OXAGEN_STEERING_APP_PRIVATE_KEY` | yes | api (steering provisioning) | Dev Steering App → generated private key (PEM) | Prod Steering App → generated private key (PEM) |
| `OXAGEN_STEERING_APP_SLUG` | no | api (steering provisioning) | Dev Steering App → public slug | Prod Steering App → public slug |

Oxagen compares the slug with the app GitHub names on the `steering` deployment when it reads the
settings back.

### Setup checklist

Create each copy at **GitHub → Settings → Developer settings → GitHub Apps → New GitHub App**, or
under your organization's settings to own it at the organization level.

1. Name it `Oxagen Steering` for production and `Oxagen Steering (Dev)` for development.
2. Set **Homepage URL** to `https://app.oxagen.sh` for production and `http://localhost:3000` for
   development.
3. Turn on **Request user authorization (OAuth) during installation**.
4. Set **Callback URL** to `{NEXT_PUBLIC_API_URL}/oauth/github/steering`:
   `http://localhost:4000/oauth/github/steering` for development and
   `https://api.oxagen.sh/oauth/github/steering` for production. This route stores the owner's
   token.
5. Leave **Expire user authorization tokens** off. Provisioning reuses the stored owner token, and
   no job refreshes it.
6. Leave **Setup URL** blank.
7. Turn **Webhook → Active** off.
8. Grant every permission in [Permissions](#permissions). Then add **Administration: Read and
   write** and **Deployments: Read and write**.
9. Set **Where can this GitHub App be installed?** to **Any account** for production, so customers
   can install it on their organizations. **Only on this account** is fine for development.
10. Generate a private key and a client secret. Copy the App ID, the Client ID and the public slug.
    Set the five variables in [Configuration](#configuration).
11. Ask an organization owner to install the app on the GitHub organization, on all repositories or
    on selected repositories.

### GitLab

GitLab has no app. An owner connects a GitLab group with a group access token that has the
Maintainer role or higher and the `api` scope. Onboarding sends it to
`POST /v1/{org_slug}/connections/steering/gitlab` with `{ "group": "<path or id>", "token": "<token>" }`
(`apps/api/src/routes/v1/gitlab-oauth.ts`). The route checks the token with GitLab first and answers
422 with `gitlab_token_invalid`, `gitlab_group_unreachable` or `gitlab_token_insufficient` when a
check fails. Oxagen stores the token in `ingestion.oauth_accounts`
with `provider = 'gitlab_steering'` and uses it the way it uses Oxagen Steering on GitHub. The
token's bot user acts on steering repos. The prescribed settings protect `main` so no one pushes
and only that bot user merges. That protection needs GitLab Premium.

---

## Known gaps / follow-ups

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
3. **Canonical topology + evidence** — derive shared topology only from a configured
   protected/default ref, and add a typed evidence ledger for verified execution-to-commit,
   artifact, test, and changed-file claims. Do not restore source-blob ingestion to deliver this.
