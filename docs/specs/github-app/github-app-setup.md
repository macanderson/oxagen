# GitHub App setup

**Audience:** operators / platform engineers configuring the GitHub connector.
**Last verified against code:** 2026-09-29.

This document is the setup reference for the one GitHub App Oxagen uses (ADR-228). It lists every
configuration value, the callback and webhook endpoints the code expects, the permissions and
events to subscribe to, and the values that differ between **development** and **production**.

| What the app acts on | Sections |
| --- | --- |
| Your code repositories. It feeds the **provider-metadata connector** and opens governed pull requests. | [TL;DR](#tldr) through [Verification checklist](#verification-checklist) |
| Steering repos. It creates each one and holds its settings. | [Steering repos](#steering-repos) |

Register the app twice, once for development and once for production, for the reasons in
[Why a dev app and a production app](#why-a-dev-app-and-a-production-app).

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
| How many GitHub Apps? | **One, registered twice (ADR-228).** A dev copy and a production copy. See [Why a dev app and a production app](#why-a-dev-app-and-a-production-app). |
| What kind of credential? | A **GitHub App** (not an OAuth App). The flow calls `/user/installations`, which only exists for GitHub Apps. |
| What grants repo access today? | Ingestion runs on the **user-to-server OAuth token**, limited by the App's **permissions**. Governed pull requests use an installation token minted with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and fall back to the user token (`packages/github/src/workspace-token.ts`). |
| Steering repos | The same app, which adds Administration and Deployments write. See [Steering repos](#steering-repos). |
| OAuth callback URL | `{NEXT_PUBLIC_API_URL}/oauth/github/callback`. It serves every connect, steering included. |
| Webhook URL | App-level `{NEXT_PUBLIC_API_URL}/webhooks/github/app` — **live**. See [Webhooks](#webhooks). |
| Setup URL | Blank. GitHub turns it off while OAuth during installation is on. See [Setup URL](#setup-url-post-install-redirect). |

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
   - `state = base64url(json).hmac` signed with `GITHUB_APP_INSTALL_STATE_SECRET`, 10-minute TTL.

   The URL carries no `scope` (GitHub Apps ignore it) and no `redirect_uri`, so GitHub returns to
   the first Callback URL in the App's settings (`packages/github/src/install-url.ts`).
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

## Why a dev app and a production app

Register the app twice, and keep each copy's credentials in its own environment:

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

A GitHub App allows up to 10 callback URLs, so callbacks alone could be shared. The single
webhook URL and secret isolation still need two registrations. Code repositories and steering repos
share each one (ADR-228).

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
- **The first Callback URL is the one GitHub uses.** `buildInstallAuthUrl` and
  `buildIdentityAuthUrl` (`packages/github/src/install-url.ts`) pass no `redirect_uri`, so GitHub
  returns every connect to the first URL in the list. A second or wildcard entry never receives a
  connect. Keep `https://api.oxagen.sh/oauth/github/callback` first until ADR-215 step A3 puts
  `https://api.oxagen.app/oauth/github/callback` there.
- **Every connect returns here.** The code repository connect and the steering connect both land on
  this callback. The signed state names what the connect is for, so no connect needs a URL of its
  own.
- **Expire user authorization tokens — leave OFF for now.** The callback stores a `refresh_token`
  when present, but there is **no token-refresh job wired yet**. Non-expiring user tokens avoid
  silent sync failures until refresh is implemented. (Revisit when installation tokens land.)
- Enabling **OAuth during installation** lets a GitHub-initiated install run the OAuth handshake in
  one hop, returning both `code` and `installation_id` to the callback.

### Setup URL (post-install redirect)

The **Setup URL** is where GitHub sends someone after an install from GitHub's own pages. GitHub
turns the field off while **Request user authorization (OAuth) during installation** is on, and
**Redirect on update** does nothing without a Setup URL.

| Field | Dev | Prod |
| --- | --- | --- |
| **Setup URL** | blank | blank |
| **Redirect on update** | off | off |

- **A first install returns to the OAuth callback.** GitHub sends `code`, `installation_id`,
  `setup_action`, and the signed `state` to the first Callback URL, and the callback finishes the
  connect.
- **An update returns nowhere.** When the organization already has the app, GitHub shows
  **Configure** on the install page and drops the state. Every in-app connect for an installed
  organization therefore goes through `login/oauth/authorize` (`buildIdentityAuthUrl` in
  `packages/github/src/install-url.ts`), which returns a code and the state to the callback.
- **An install with no state** records its installation id in the platform registry and redirects
  to `{NEXT_PUBLIC_APP_URL}/?github_installed=1`. The `installation` webhook enriches the record.
- `apps/app/src/app/github/setup/route.ts` (`handleGithubSetup`) still answers a Setup URL leg from
  an older registration. A current registration never sends one.

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
| **Administration** | Read and write | Create each steering repo, apply its rulesets and merge settings, turn Actions off, and create the `steering` environment. See [Steering repos](#steering-repos). |
| **Deployments** | Read and write | Record each published steering version as a deployment to the `steering` environment. |

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

**Administration write reaches every repository an installation covers** (ADR-228). Before ADR-228
a second app held it, so an installation on code repositories never did. Oxagen uses it only in the
steering repo code paths, and the steering repo's `Oxagen merges` ruleset names this app as its only
bypass actor. ADR-228 lists the token paths that can reach a steering repo and which of them refuse
it.

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
   A verified delivery that can change a steering repo's settings also asks for a health read. See
   [Health webhooks](#health-webhooks). A failure there is logged and never fails the delivery.
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
| `repository_ruleset` | none. It asks for a steering repo health read. |
| `branch_protection_configuration` | none. It asks for a steering repo health read. |

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
| `GITHUB_APP_ID` | no | api, app, mcp (installation tokens, steering) | Dev App → App ID | Prod App → App ID |
| `GITHUB_APP_PRIVATE_KEY` | yes | api, app, mcp (installation tokens, steering) | Dev App → generated private key (PEM) | Prod App → generated private key (PEM) |
| `GITHUB_APP_SLUG` | no | api (required for the steering connect and provisioning); app, mcp (optional) | Dev App → public slug | Prod App → public slug |
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
  the slug from an existing installation. The steering connect and steering provisioning need it.
  See [Configuration](#configuration).

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
   `https://github.com/login/oauth/authorize?...` URL with no `redirect_uri`. The App's first
   Callback URL must be `{NEXT_PUBLIC_API_URL}/oauth/github/callback` exactly.
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
7. **Steering:** as an organization Owner, connect GitHub from onboarding. Confirm the redirect
   carries `steering=connected` and a row in `ingestion.oauth_accounts` has
   `provider = 'github_steering'`.

---

## Steering repos

A steering repo holds steering records. Each workspace gets a private repository named
`oxagen-<workspace-slug>`, and the organization gets `<org>/oxagen`. The Oxagen app creates and
runs them with the permissions in [Permissions](#permissions), Administration and Deployments
write included.

### Reason for one app

Until ADR-228, a second app, Oxagen Steering, held Administration write, so an installation on code
repositories never did. ADR-228 folds it into the Oxagen app for two reasons:

1. GitHub returns every install and every authorization to an app's first Callback URL, because
   `installations/new` takes no `redirect_uri`. A second app needed its own callback route, its
   own credentials, and its own webhook secret, and production never registered it (#4634).
2. An owner had to install two apps on one organization and could install one without the other.

The cost is that Administration write reaches every repository an installation covers, and the app
that holds the `Oxagen merges` bypass is the app every Oxagen installation token comes from.
ADR-228 records which token paths refuse the steering repo and which do not yet.

### Provisioning steps

The durable job `steering-repo/provision` (`packages/handlers/src/steering_repo.provision.ts`) runs
these steps. An installation token for the Oxagen app makes every change on GitHub except the one in
step 2. Every step is safe to repeat, and a rerun adopts what an earlier run made.

1. It creates the repository in your GitHub organization. When the name is taken, it tries `-2`,
   `-3`, and so on.
2. It adds the repository to the installation with the owner's user token. See
   [Installation](#installation).
3. It writes the first commit to `main`.
4. It applies the prescribed settings (`packages/oxagen/src/steering-repo/settings-baseline.ts`) and
   reads them back:
   - The `Oxagen steering` ruleset on `main` requires the `Oxagen steering` status check, pinned to
     the Oxagen app so no one else can post it. It has no bypass actors.
   - The `Oxagen merges` ruleset on `main` restricts updates. Its only bypass actor is the Oxagen
     app, so every steering PR reaches `main` through Oxagen.
   - Squash merges only, and head branches deleted after a merge.
   - Actions off.
   - The `steering` environment, which accepts deployments from `main` only.
5. It records version 1 as a deployment to the `steering` environment.
6. For a workspace repo, it binds the repository to the workspace with role `steering`.

### Installation

An organization owner installs the Oxagen app on your GitHub organization. With **Request user
authorization (OAuth) during installation** on, the install also authorizes that owner. Onboarding
stores the owner's user-to-server token in `ingestion.oauth_accounts` with
`provider = 'github_steering'`.

Onboarding starts the connect at
`GET /v1/{org_slug}/connections/steering/github?mode=install|authorize&return_to=<path>`
(`apps/api/src/routes/v1/github-oauth.ts`). Only an organization Owner or Admin may call it.

- `mode=install` sends the owner to the app's `installations/new` page, which installs the app and
  authorizes the owner in one pass. Onboarding offers it first.
- `mode=authorize` sends the owner to `login/oauth/authorize`. Use it when the organization already
  has the app. GitHub then shows **Configure** on the install page, drops the state, and returns no
  code.

Both carry a state signed with purpose `steering`, and GitHub returns both to the app's one
callback, `GET /oauth/github/callback`. The callback checks the signature and the purpose, and
answers 400 to a state signed for anything else. For a steering state it records the installation
id in the platform registry, exchanges the code with `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`, stores the token, and sends the provision event again for each scope
that waits on a connection. It then redirects to `return_to` with `steering=connected`, or with
`steering=error&code=<reason>` when a step after the state check fails. The start route ignores the
retired `app` parameter. `GET /oauth/github/steering` is gone and answers 404.

Provisioning reads the owner's installations with that token (`GET /user/installations`) and makes
one change with it: `PUT /user/installations/{installation_id}/repositories/{repository_id}`. That
call adds the new repository to an installation limited to selected repositories. The endpoint
takes a user token, so an installation token cannot make it. An installation on all repositories
already covers the new repository, so provisioning skips the call.

When no token is stored, or GitHub answers 401, 403, or 404, provisioning stops at the
`add_to_installation` step with `steering_reauthorize`. Oxagen raises a banner that asks an
organization owner to authorize the Oxagen app again. A retry starts from that step.

### Health webhooks

The app's one webhook in [Webhooks](#webhooks) also tells Oxagen about a change to a steering
repo's settings when it happens. Provisioning needs none of these events. The last three are in the
ingestion list already. Add the first two:

| GitHub event | Why Oxagen reads it |
| --- | --- |
| `repository_ruleset` | A ruleset was created, edited, or deleted. |
| `branch_protection_configuration` | Branch protection was turned on or off. |
| `repository` | The repository was edited, renamed, transferred, archived, unarchived, deleted, or made public or private. |
| `push` | Someone pushed to `main`. Oxagen merges every commit on `main`, so a push can mean the repo diverged. |
| `pull_request` | A steering PR opened, reopened, became ready for review, or got a new head, so its check needs posting. |

GitHub sends `installation` and `installation_repositories` without a subscription. Oxagen reads
them when a steering repo leaves the installation, or when the app is suspended or removed.

The route (`apps/api/src/routes/v1/github-webhook.ts`) verifies each delivery with
`GITHUB_APP_WEBHOOK_SECRET`. A verified delivery that can change a steering repo's health sends one
`steering-repo/health.requested` event per scope that holds the repo
(`packages/handlers/src/steering-repo/health.events.ts`), and then goes on to the installation
lifecycle and ingestion. A failure to send is logged and never fails the delivery. The durable job
`steering-repo/health-check` (`packages/inngest-functions/src/functions/steering-repo.sweep.ts`)
reads the repo's settings and stores its health. While the repo is not healthy, the job fails the
`Oxagen steering` check on every open steering PR. The job `steering-repo/health-sweep` asks for
the same read for every ready steering repo every 10 minutes, so a lost delivery delays a drift
report until the next sweep.

### Configuration

Steering adds no variables. It reads the app's own from
[Environment variables](#environment-variables). `steeringAppFromEnv()` in
`packages/handlers/src/lib/steering-app.ts` reads `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, and
`GITHUB_APP_SLUG`. When any of those is unset, or the App ID is not a positive integer, provisioning
stops with `steering_app_unconfigured`. The steering connect reads those three,
`GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_INSTALL_STATE_SECRET`. When one
is unset, it answers 503 with `github_app_unconfigured` and names the variable.

Oxagen compares the slug with the app GitHub names on the `steering` deployment when it reads the
settings back.

The `OXAGEN_STEERING_APP_*` variables are retired, and nothing reads them. Delete them from
Parameter Store after the deploy that carries ADR-228.

### Setup checklist

On each copy of the app, from its settings page on GitHub:

1. Keep **Request user authorization (OAuth) during installation** on, and leave **Setup URL**
   blank.
2. Keep `{NEXT_PUBLIC_API_URL}/oauth/github/callback` first in **Callback URLs**. Steering needs no
   URL of its own.
3. Leave **Expire user authorization tokens** off. Provisioning reuses the stored owner token, and
   no job refreshes it.
4. Under **Permissions**, add **Administration: Read and write** and **Deployments: Read and
   write**. GitHub asks the owner of each existing installation to accept them. Until an owner
   does, that installation keeps its old permissions, and provisioning cannot create a repository
   through it.
5. Under **Subscribe to events**, add `repository_ruleset` and `branch_protection_configuration`.
6. Ask an organization owner to install the app on the GitHub organization, on all repositories or
   on selected repositories, or to accept the new permissions on an installation it already has.

### Moving from the Oxagen Steering app

A steering connection made through the retired app holds a token that app issued. The Oxagen app's
installations are invisible to that token, so provisioning stops with `steering_reauthorize`, and an
owner connects again from onboarding.

1. Install the Oxagen app on the same GitHub account the retired app was on. Select the steering
   repos the retired app created, or choose **All repositories**. An installation that cannot see a
   steering repo cannot mint a token for it.
2. Finish the connect. The callback replaces the retired installation id in the organization's
   steering connection and in each steering source connection. It moves an id only on the same
   account, because a GitHub App has one installation per account.
3. Repair each steering repo (`repair_steering_repo`). A steering repo the retired app set up names
   that app in its rulesets, so its health read reports drift until an organization admin repairs
   it.
4. Uninstall the retired app from the organization after the repair.

### GitLab

GitLab has no app. An owner connects a GitLab group with a group access token that has the
Maintainer role or higher and the `api` scope. Onboarding sends it to
`POST /v1/{org_slug}/connections/steering/gitlab` with `{ "group": "<path or id>", "token": "<token>" }`
(`apps/api/src/routes/v1/gitlab-oauth.ts`). The route checks the token with GitLab first and answers
422 with `gitlab_token_invalid`, `gitlab_group_unreachable`, `gitlab_token_not_group` or
`gitlab_token_insufficient` when a check fails. It takes only the group's own access token: GitLab
must report the token's user as a bot named `group_<id>_bot…` for the group's id. It refuses a
personal access token, which reaches every group its person belongs to, and a project or parent
group token, which belongs to something other than this group. Oxagen stores the token in
`ingestion.oauth_accounts` with `provider = 'gitlab_steering'` and uses it the way it uses the
Oxagen app on GitHub. The
token's bot user acts on steering repos. The prescribed settings protect `main` so no one pushes
and only that bot user merges. That protection needs GitLab Premium.

The GitLab webhook route (`apps/api/src/routes/v1/gitlab-webhook.ts`) asks for a steering repo
health read on a push to `main`, on a merge request with a new head, and on a project or
membership event that names the project.

Provisioning registers one project hook on each GitLab steering project in its `register_webhook`
step (#4562). The hook posts push and merge request events to
`/webhooks/gitlab/steering/<workspace|organization>/<id>` on `OXAGEN_API_URL`, with SSL
verification on. Its token is an HMAC of the scope and the project id under `BETTER_AUTH_SECRET`
(`packages/handlers/src/lib/steering-hook.ts`), so one scope's token fails on every other hook. The
receiver (`packages/handlers/src/gitlab.steering-webhook.ts`) checks the token against the project
that the scope's steering repo names, and answers 401 when it does not match. It asks for a health
read on a push to `main`. For a workspace, it also asks for a repository sync (ADR-184) on a push to
`main` or a merge. A rerun of provisioning writes the current token onto the same hook. When GitLab
refuses the hook's URL, as GitLab.com does for a localhost `OXAGEN_API_URL`, the step logs a
warning and finishes. The 10-minute sweep then finds drift until a later run registers the hook.

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
  (`apps/app/src/app/github/setup/route.ts`), kept for older registrations (ADR-228); resolves the membership-gated workspace and the wizard
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
