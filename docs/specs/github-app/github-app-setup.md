# GitHub App setup

**Audience:** operators / platform engineers configuring the GitHub connector.
**Last verified against code and the live apps:** 2026-10-01T01:02Z. Staging still lacks Workflows.
See [Permissions](#permissions).

This document is the setup reference for the GitHub App Oxagen uses (ADR-228). It lists every
configuration value, the callback and webhook endpoints the code expects, the permissions and
events to subscribe to, and the values that differ between **local**, **staging**, and
**production**.

| What the app acts on | Sections |
| --- | --- |
| Your code repositories. It feeds the **provider-metadata connector** and opens governed pull requests. | [TL;DR](#tldr) through [Verification checklist](#verification-checklist) |
| Steering repos. It creates each one and holds its settings. | [Steering repos](#steering-repos) |

The app is registered once per environment, for the reasons in [Apps](#apps).

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
| How many GitHub Apps? | **One app, registered once per environment (ADR-228):** local, staging, and production. The `oxageninc` GitHub organization owns all of them. See [Apps](#apps). |
| What kind of credential? | A **GitHub App** (not an OAuth App). The flow calls `/user/installations`, which only exists for GitHub Apps. |
| What grants repo access today? | Ingestion runs on the **user-to-server OAuth token**, limited by the App's **permissions**. Governed pull requests use an installation token minted with `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY`, and fall back to the user token (`packages/github/src/workspace-token.ts`). |
| Permissions | Read and write on Actions, Administration, Checks, Commit statuses, Contents, Deployments, Issues, Pull requests, and Workflows. Read-only on Metadata. Nothing else. See [Permissions](#permissions). |
| Steering repos | The same app. See [Steering repos](#steering-repos). |
| OAuth callback URL | `{NEXT_PUBLIC_API_URL}/oauth/github/callback`, first in the list, with wildcard matching off. It serves every connect, steering included. |
| Webhook URL | `{NEXT_PUBLIC_API_URL}/webhooks/github/app`. See [Webhooks](#webhooks). |
| Setup URL | Blank. GitHub turns it off while OAuth during installation is on. See [Setup URL](#setup-url-post-install-redirect). |
| Sign in with GitHub | A separate GitHub OAuth App (`GITHUB_LOGIN_CLIENT_ID` and `GITHUB_LOGIN_CLIENT_SECRET`, read in `packages/auth/src/auth.ts`). Changing this GitHub App does not touch sign-in. |

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

> **Note on `scope`.** Neither `packages/github/src/install-url.ts` nor
> `apps/api/src/routes/v1/github-oauth.ts` sends a `scope`, and GitHub Apps ignore one. The App's
> **permissions** and the installations and repositories the user can reach decide what a
> user-to-server token can do.

> **Note on tokens.** Ingestion runs on the **user's** OAuth token, not an installation access
> token (ingestion never reads the App private key or App ID). This is simpler but means sync is tied to the
> authorizing user's continued access. Migrating to installation tokens (JWT signed with the App
> private key → installation access token) is a recommended future hardening. See
> [Known gaps](#known-gaps--follow-ups).

---

## Apps

The `oxageninc` GitHub organization owns every copy of the app. Each environment keeps its own
copy's credentials:

| App | Slug | App ID | Environment | API origin (`NEXT_PUBLIC_API_URL`) | App origin (`NEXT_PUBLIC_APP_URL`) |
| --- | --- | --- | --- | --- | --- |
| **Oxagen Connect** | `oxagen-connect` | 4168398 | production | `https://api.oxagen.sh` | `https://app.oxagen.sh` |
| **Oxagen Github Connect Staging** | `oxagen-github-connect-staging` | 4993204 | staging | `https://api.staging.oxagen.sh` | `https://app.staging.oxagen.sh` |
| **Oxagen Github Connect Local** | `oxagen-github-connect-local` | 4055401 | local | `http://localhost:4000` | `http://localhost:3000` |
| **Oxagen Github Connect** | `oxagen-github-connect` | 5121606 | retired | none | none |

Each app's settings page sits at `https://github.com/organizations/oxageninc/settings/apps/<slug>`.
GitHub asks an organization owner to confirm access (sudo mode) before it shows one. The sections
below record each app's settings as read from GitHub on 2026-10-01. No section holds a secret: the
credentials live where each section's **Credentials** row says.

### Oxagen Connect

The production app. Customers install it on their GitHub organizations so Oxagen can ingest their
repository metadata, open governed pull requests, post its pull request check, and create and run
their steering repos.

| Setting | Value |
| --- | --- |
| Display name | Oxagen Connect |
| Slug | `oxagen-connect` |
| App ID | 4168398 |
| Owner | `oxageninc` (GitHub organization) |
| Environment | production |
| Public page | `https://github.com/apps/oxagen-connect` |
| Install page | `https://github.com/apps/oxagen-connect/installations/new` |
| Settings page | `https://github.com/organizations/oxageninc/settings/apps/oxagen-connect` |
| Homepage URL | `https://oxagen.sh` |
| Redirect URIs | `https://api.oxagen.sh/oauth/github/callback`, wildcard matching off. The only entry. |
| Request user authorization (OAuth) during installation | on |
| Enable Device Flow | off |
| Setup URL | blank. GitHub disables the field while OAuth during installation is on. |
| Redirect on update | on. The [Setup URL](#setup-url-post-install-redirect) table requires off. On 2026-10-01 this setting sent a steering connect to the Homepage URL. |
| Webhook | `https://api.oxagen.sh/webhooks/github/app`, active |
| Permissions | The [required set](#permissions), applied 2026-10-01T00:34:16Z |
| Events | The [15 required events](#webhook-config-on-the-app), applied the same time. App-level `installation_target` and `meta` on, `security_advisory` off. |
| Credentials | Parameter Store SecureStrings under `/oxagen/production/`: `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_WEBHOOK_SECRET`, and `GITHUB_APP_INSTALL_STATE_SECRET` |

### Oxagen Github Connect Staging

The staging app. It serves `api.staging.oxagen.sh` and `app.staging.oxagen.sh`, so a change can be
connected end to end before it reaches production. Staging is dormant while the `STAGING_ENABLED`
repository variable is not `true` (#4868). Keep the app configured so staging works when it wakes.

| Setting | Value |
| --- | --- |
| Display name | Oxagen Github Connect Staging |
| Slug | `oxagen-github-connect-staging` |
| App ID | 4993204 |
| Owner | `oxageninc` (GitHub organization) |
| Environment | staging |
| Public page | `https://github.com/apps/oxagen-github-connect-staging` |
| Settings page | `https://github.com/organizations/oxageninc/settings/apps/oxagen-github-connect-staging` |
| Homepage URL | `https://app.staging.oxagen.sh` |
| Redirect URIs | `https://api.staging.oxagen.sh/oauth/github/callback`, wildcard matching off. The only entry. |
| Request user authorization (OAuth) during installation | on |
| Enable Device Flow | off |
| Setup URL | blank |
| Redirect on update | off |
| Webhook | `https://api.staging.oxagen.sh/webhooks/github/app`, active |
| Permissions | The [required set](#permissions). On 2026-10-01T01:02Z it held all of it except Workflows, which Mac adds by hand. |
| Events | The [15 required events](#webhook-config-on-the-app), applied 2026-10-01T01:00:50Z |
| Credentials | Parameter Store SecureStrings under `/oxagen/staging/`, the same seven `GITHUB_APP_*` names as production |

### Oxagen Github Connect Local

The local development app. It serves an API on `localhost:4000` and the web app on
`localhost:3000`, so a developer can run a connect without touching staging or production
credentials.

| Setting | Value |
| --- | --- |
| Display name | Oxagen Github Connect Local |
| Slug | `oxagen-github-connect-local` |
| App ID | 4055401 |
| Owner | `oxageninc` (GitHub organization) |
| Environment | local |
| Public page | `https://github.com/apps/oxagen-github-connect-local` |
| Settings page | `https://github.com/organizations/oxageninc/settings/apps/oxagen-github-connect-local` |
| Homepage URL | `http://localhost:3000` |
| Redirect URIs | `http://localhost:4000/oauth/github/callback`, wildcard matching off. The only entry. |
| Request user authorization (OAuth) during installation | on |
| Enable Device Flow | off |
| Setup URL | `http://localhost:3000/connections/github/setup`. GitHub greys it out and ignores it while OAuth during installation is on. |
| Redirect on update | on. The [Setup URL](#setup-url-post-install-redirect) table requires off. With it on and the Setup URL ignored, GitHub sends a person to the Homepage URL. |
| Webhook | inactive, URL blank |
| Permissions | The [required set](#permissions), applied 2026-10-01T01:02:27Z |
| Events | none. GitHub drops every event subscription while an app's webhook is inactive. To receive webhooks locally, follow the steps in [Webhooks](#webhooks). |
| Credentials | `apps/api/.env.local` on the developer's machine. See [Environment variables](#environment-variables). |

### Oxagen Github Connect (retired)

The retired steering app. Until ADR-228 it created and ran steering repos as a second app, the
Oxagen Steering app. ADR-228 folded steering into the one app per environment. Nothing reads its
credentials, and its redirect URIs point at `/oauth/github/steering`, which answers 404. Uninstall
it after [Moving from the Oxagen Steering app](#moving-from-the-oxagen-steering-app), then delete
it. Do not bring its permissions or events in line with the required set.

| Setting | Value |
| --- | --- |
| Display name | Oxagen Github Connect |
| Slug | `oxagen-github-connect` |
| App ID | 5121606 |
| Owner | `oxageninc` (GitHub organization) |
| Environment | none (retired) |
| Public page | `https://github.com/apps/oxagen-github-connect` |
| Settings page | `https://github.com/organizations/oxageninc/settings/apps/oxagen-github-connect` |
| Homepage URL | `https://app.oxagen.sh` |
| Redirect URIs | `https://api.oxagen.sh/oauth/github/steering` and `https://api.oxagen.app/oauth/github/steering`, wildcard matching off on both |
| Request user authorization (OAuth) during installation | on |
| Enable Device Flow | off |
| Setup URL | blank |
| Redirect on update | off |
| Webhook | `https://api.oxagen.sh/webhooks/github/app`, active |
| Permissions | 25 repository permissions, left as they were at retirement |
| Events | 32 repository events, plus the app-level `security_advisory` event |
| Credentials | Retired Parameter Store SecureStrings under `/oxagen/production/`: `OXAGEN_STEERING_APP_ID`, `OXAGEN_STEERING_APP_SLUG`, `OXAGEN_STEERING_APP_CLIENT_ID`, `OXAGEN_STEERING_APP_CLIENT_SECRET`, `OXAGEN_STEERING_APP_PRIVATE_KEY`, and `OXAGEN_STEERING_APP_WEBHOOK_SECRET`. Delete them once a production steering delivery returns 200 through Oxagen Connect. |

### oxagen.sh (deleted)

The first production app (`oxagen-sh`, App ID 4055615, owned by `oxageninc-old`). Mac deleted it on
2026-10-01, after Oxagen Connect had been installed on every account that carried it. The webhook
route now verifies only Oxagen Connect's deliveries. A delivery from any other app, such as the
retired steering app above, is answered 200 and dropped, with a `webhook_from_other_app` log line
(`apps/api/src/routes/v1/github-webhook.ts`, #4937). Its webhook secret, `GITHUB_WEBHOOK_SECRET`,
is gone from the code, and its Parameter Store value is deleted once that change deploys.

### Reasons for one app per environment

1. **A GitHub App has a single global webhook URL.** Local must point at a public tunnel
   (smee.io or cloudflared), and staging and production each point at their own API. One App cannot
   serve all three.
2. **Secret isolation (SOC 2).** A leaked local or staging client secret, webhook secret, or state
   secret must never grant access to production data.
3. **Blast-radius separation.** Regenerating one copy's secret or rotating its private key must not
   disrupt another environment's ingestion.

A GitHub App allows up to 10 callback URLs, so callbacks alone could be shared. The single
webhook URL and secret isolation still need one registration per environment. Code repositories and
steering repos share each one (ADR-228).

---

## GitHub App configuration

Create a new copy under the `oxageninc` organization's settings, at **Developer settings → GitHub
Apps → New GitHub App**, so the organization owns it.

### Identity

| Field | Local | Staging | Production |
| --- | --- | --- | --- |
| **GitHub App name** | `Oxagen Github Connect Local` | `Oxagen Github Connect Staging` | `Oxagen Connect` |
| **Homepage URL** | `http://localhost:3000` | `https://app.staging.oxagen.sh` | `https://oxagen.sh` |

### Identifying and authorizing users (OAuth)

GitHub's settings page calls a callback URL a **Redirect URI**.

| Field | Local | Staging | Production |
| --- | --- | --- | --- |
| **Callback URL** (first and only) | `http://localhost:4000/oauth/github/callback` | `https://api.staging.oxagen.sh/oauth/github/callback` | `https://api.oxagen.sh/oauth/github/callback` |
| **Allow wildcard matching** | off | off | off |
| **Request user authorization (OAuth) during installation** | on | on | on |
| **Enable Device Flow** | off | off | off |
| **Expire user authorization tokens** | off | off | off |

- The **Callback URL** must exactly match `{NEXT_PUBLIC_API_URL}/oauth/github/callback`. Localhost
  is valid here because the *browser* performs the redirect (GitHub's servers don't call it).
- **The first Callback URL is the one GitHub uses.** `buildInstallAuthUrl` and
  `buildIdentityAuthUrl` (`packages/github/src/install-url.ts`) pass no `redirect_uri`, so GitHub
  returns every connect to the first URL in the list. A second or wildcard entry never receives a
  connect. Keep `https://api.oxagen.sh/oauth/github/callback` first. The API stays on `oxagen.sh`
  (ADR-236), so no `api.oxagen.app` URL belongs in the list.
- **Every connect returns here.** The code repository connect and the steering connect both land on
  this callback. The signed state names what the connect is for, so no connect needs a URL of its
  own.
- **Keep wildcard matching off, and never put a bare origin first.** On 2026-09-30 production's
  first entry was `https://oxagen.sh` with wildcard matching on. GitHub sent every install and
  connect to the marketing site, which answered 200 and finished nothing. Wildcard matching also
  lets an authorize link send a code to any subdomain or path under the entry.
- **Leave Expire user authorization tokens off for now.** The callback stores a `refresh_token`
  when present, but there is **no token-refresh job wired yet**. Non-expiring user tokens avoid
  silent sync failures until refresh is implemented. (Revisit when installation tokens land.)
- Enabling **OAuth during installation** lets a GitHub-initiated install run the OAuth handshake in
  one hop, returning both `code` and `installation_id` to the callback.

### Setup URL (post-install redirect)

The **Setup URL** is where GitHub sends someone after an install from GitHub's own pages. GitHub
turns the field off while **Request user authorization (OAuth) during installation** is on. Keep
**Redirect on update** off: with it on and no Setup URL, GitHub sends someone who updates an
installation to the Homepage URL.

| Field | Local | Staging | Production |
| --- | --- | --- | --- |
| **Setup URL** | blank | blank | blank |
| **Redirect on update** | off | off | off |

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
- **A return to the Homepage URL with `?code=…&state=…` means a field above drifted.** GitHub
  falls back to the Homepage URL when **Redirect on update** is on and the Setup URL is blank, so
  a person lands on the marketing site holding an unused code. On 2026-10-01 the production app
  (`oxagen-connect`, 4168398) had **Redirect on update** on and its **Homepage URL** set to
  `https://oxagen.sh`, and a steering connect from the Repositories page ended on
  `https://oxagen.sh/?code=…`. Set the two values in the tables above, and check them again after
  anyone edits the app.

### Permissions

Local, staging, and production each need exactly this set. Oxagen sends no OAuth `scope`, so these
permissions, and the repositories an installation covers, are the whole grant.

> **Staging lacks Workflows (2026-10-01T01:02Z).** Production has carried this set since
> 2026-10-01T00:34:16Z and local since 2026-10-01T01:02:27Z. Staging holds all of it except
> Workflows. Add Workflows: Read and write on the staging app's **Permissions & events** page, and
> remove this note once it matches.

**Repository permissions:**

| Permission | Access | What uses it |
| --- | --- | --- |
| **Actions** | Read and write | Steering settings read the `steering` environment and its branch policies (`packages/github/src/provision/settings.ts:160` and `:172`), and GitHub gates those reads on Actions. Write lets Oxagen re-run a pull request's CI. |
| **Administration** | Read and write | Steering provisioning creates the repository (`POST /orgs/{org}/repos` in `packages/github/src/provision/repository.ts`), applies private visibility and merge settings, and turns Actions off (`settings.ts`). See [Steering repos](#steering-repos). |
| **Checks** | Read and write | Oxagen posts its own check run on a pull request's head commit: the `Oxagen steering` check (`packages/handlers/src/steering-repo/health.hosts.ts:243`) and each governed-file check (`packages/github/src/fetch-client.ts:1297`). A required Oxagen check turns a pull request red, the way Vercel's and Greptile's do, which PR verification needs. |
| **Commit statuses** | Read and write | `listCiChecks` (`packages/github/src/fetch-client.ts:1095`) reads the combined status on every CI status read. Write lets Oxagen post a commit status where a repository requires one. |
| **Contents** | Read and write | Branches, commits, file writes, and merges for governed pull requests and steering repos. The git push token Tacho mints (`packages/handlers/src/tacho.github_token.issue.ts`) narrows to Contents write. |
| **Deployments** | Read and write | Each published steering version becomes a deployment to the `steering` environment (`packages/github/src/deployments.ts`). |
| **Issues** | Read and write | Ingestion reads issues and comments. `packages/handlers/src/run-issue-provider.ts` creates issues with a token minted for `issues: "write"`, and GitHub refuses to mint a token above what the installation holds. |
| **Metadata** | Read-only | Mandatory. Repository names, default branches, and an installation's repository list. |
| **Pull requests** | Read and write | Opens, updates, merges, and reads the pull requests that carry a skill, an agent definition, a context record, or a tool, with their labels and comments. It also covers replies to review comments and resolving review threads, which PR verification needs. |
| **Workflows** | Read and write | Contents write cannot change a file under `.github/workflows/`. An agent that writes code and opens a pull request needs Workflows to change CI files. Steering seed files and the Tacho push token never use it. |

Every other repository permission is **No access**. The app holds no organization or account
permissions: no code reads organization members, teams, or the user's email.

**Changing the set.** GitHub applies a removed permission to every installation at once. An added
permission waits until each installation's owner accepts it, and until then that installation keeps
its old set and Oxagen gets 403 on the calls that need the new one.

**This App is read-write** (decided 2026-09-18, on #3242). Mac widened it on 2026-09-30 to the set
above, for an Oxagen check on every pull request, replies to and resolution of review comments, and
agents that change code, CI files included. Earlier revisions of this document said
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
steering repo code paths. Steering setup supports GitHub Free and does not configure rulesets
or branch protection. ADR-228 lists the token paths that can reach a steering repo and which of them refuse
it.

### Where can this App be installed?

- **Local and staging:** "Only on this account" is enough.
- **Production:** "Any account", because customers install it in their own organizations.

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
> record types are received and skipped by design. Map the types you want to ingest continuously.

### Webhook config on the App

| Field | Local | Staging | Production |
| --- | --- | --- | --- |
| **Active** | off, unless a tunnel runs | on | on |
| **Webhook URL** | `https://{your-tunnel}/webhooks/github/app` | `https://api.staging.oxagen.sh/webhooks/github/app` | `https://api.oxagen.sh/webhooks/github/app` |
| **Secret** | that environment's `GITHUB_APP_WEBHOOK_SECRET` | that environment's `GITHUB_APP_WEBHOOK_SECRET` | that environment's `GITHUB_APP_WEBHOOK_SECRET` |
| **SSL verification** | Enable | Enable | Enable |

Do not point a webhook at `api.oxagen.app`. #4882 removes that name, and the API stays on
`oxagen.sh` (ADR-236). Production's webhook moved from `api.oxagen.app` to `api.oxagen.sh` on
2026-10-01.

**Subscribe to these 15 events.** The route verifies every delivery and answers 200. An event no
code reads yet costs the API a signature check and one connection lookup, and dispatches nothing.

| GitHub event | What reads it |
| --- | --- |
| `push` | Ingestion: `commit`, one per commit. Steering health: a push to `main`. |
| `pull_request` | Ingestion: `pull_request`. Steering health: posts the steering check. |
| `pull_request_review` | Ingestion: `code_review`. |
| `pull_request_review_comment` | Ingestion: `comment`. |
| `pull_request_review_thread` | Nothing yet. PR verification will read thread resolution. |
| `issues` | Ingestion: `issue`. |
| `issue_comment` | Ingestion: `comment`. |
| `release` | Ingestion: `release`. |
| `repository` | Ingestion: `repository`. Steering health read. |
| `repository_ruleset` | Steering health read. |
| `branch_protection_configuration` | Steering health read. |
| `check_run` | Nothing yet. A re-run request on Oxagen's check arrives as this event. |
| `check_suite` | Nothing yet. A re-run request on the whole suite arrives as this event. |
| `status` | Nothing yet. PR verification will read other CI results. |
| `workflow_run` | Nothing yet. PR verification will read other CI results. |

`installation` and `installation_repositories` are delivered automatically (no subscription needed)
and drive the pause-on-uninstall reconciliation.

> **Local webhooks need a public tunnel.** GitHub cannot reach `localhost`, and it drops the local
> app's event subscriptions while its webhook is inactive. To receive webhooks locally:
>
> 1. Start a tunnel to `http://localhost:4000` with smee.io, `cloudflared tunnel`, or `ngrok`.
> 2. On the local app's settings page, set the Webhook URL to `https://{your-tunnel}/webhooks/github/app`
>    and the secret to your local `GITHUB_APP_WEBHOOK_SECRET`.
> 3. Turn **Active** on and save.
> 4. On **Permissions & events**, tick the 15 events above and save.

---

## Environment variables

Most GitHub connector variables live in the **`api`** service (read in `apps/api`). The
**Required where** column names the others. Schema: `packages/config/src/env.ts`. Registry:
`packages/config/src/registry.ts`.

> **Local: put these in `apps/api/.env.local`, not the repo-root `.env.local`.** `apps/api` loads
> its env through `tsx --env-file`, which resolves against the working directory. `GITHUB_APP_*`
> placed only in the root `.env.local` does nothing, and the connector returns 503. This gap has
> broken the connector before.

| Variable | Secret | Required where | Local value (`apps/api/.env.local`) | Production value (Parameter Store) |
| --- | --- | --- | --- | --- |
| `GITHUB_APP_CLIENT_ID` | no | api | Local App → Client ID | `/oxagen/production/GITHUB_APP_CLIENT_ID` |
| `GITHUB_APP_CLIENT_SECRET` | yes | api | Local App → generated client secret | `/oxagen/production/GITHUB_APP_CLIENT_SECRET` |
| `GITHUB_APP_WEBHOOK_SECRET` | yes | api (required for webhooks) | Local App webhook secret | `/oxagen/production/GITHUB_APP_WEBHOOK_SECRET` |
| `GITHUB_APP_INSTALL_STATE_SECRET` | yes | api | `openssl rand -hex 32` (local value) | `/oxagen/production/GITHUB_APP_INSTALL_STATE_SECRET`, a distinct value |
| `GITHUB_APP_ID` | no | api, app, mcp (installation tokens, steering) | Local App → App ID | `/oxagen/production/GITHUB_APP_ID`: Oxagen Connect's App ID, 4168398 |
| `GITHUB_APP_PRIVATE_KEY` | yes | api, app, mcp (installation tokens, steering) | Local App → generated private key (PEM) | `/oxagen/production/GITHUB_APP_PRIVATE_KEY` (PEM) |
| `GITHUB_APP_SLUG` | no | api (required for the steering connect and provisioning); app, mcp (optional) | `oxagen-github-connect-local` | `/oxagen/production/GITHUB_APP_SLUG`: `oxagen-connect` |
| `NEXT_PUBLIC_API_URL` | no | all | `http://localhost:4000` | `https://api.oxagen.sh` |
| `NEXT_PUBLIC_APP_URL` | no | all | `http://localhost:3000` | `https://app.oxagen.sh` |
| `INGESTION_CRYPTO_PROVIDER` | no | optional | `env` | `env` (or `kms`) |
| `INGESTION_ENCRYPTION_KEY` | yes | preview/prod | `openssl rand -base64 32` | required: it wraps OAuth token encryption |
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

### Setting staging and production values

Put each `GITHUB_APP_*` value in Parameter Store as a SecureString under `/oxagen/production/`, or
under `/oxagen/staging/` for the staging app. Each container reads its values when it starts
(`infra/tools/node/README.md`), so a changed value takes effect on the next deploy of api, app, and
mcp. Store `GITHUB_APP_PRIVATE_KEY` with its newlines. `NEXT_PUBLIC_API_URL` and
`NEXT_PUBLIC_APP_URL` are static values in `packages/config/src/registry.ts`, not Parameter Store.
Confirm `INGESTION_ENCRYPTION_KEY` and `AUTH_TOKEN_ENCRYPTION_KEY` are present before first use.

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
7. **Steering:** as an organization Owner, connect GitHub from onboarding. Confirm the browser
   lands back on onboarding with `steering=connected` and a row in `ingestion.oauth_accounts` has
   `provider = 'github_steering'`.

---

## Steering repos

A steering repo holds steering records. Each workspace gets a private repository named
`oxagen-<workspace-slug>`, and the organization gets `<org>/oxagen-config`. The Oxagen app creates and
runs them with the permissions in [Permissions](#permissions), Administration and Deployments
write included.

### Reason for one app

Until ADR-228, a second app, Oxagen Steering, held Administration write, so an installation on code
repositories never did. ADR-228 folds it into the Oxagen app for two reasons:

1. GitHub returns every install and every authorization to an app's first Callback URL, because
   `installations/new` takes no `redirect_uri`. A second app needed its own callback route, its
   own credentials, and its own webhook secret, and production never registered it (#4634).
2. An owner had to install two apps on one organization and could install one without the other.

The cost is that Administration write reaches every repository an installation covers.
Every Oxagen installation token comes from that app.
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
   - Private visibility and `main` as the default branch.
   - Squash merges only, and head branches deleted after a merge.
   - Actions off.

   GitHub Free organizations and personal accounts are supported. Oxagen does not create or
   require branch protection, rulesets, or environment protection. Health and repair use the same
   baseline. Existing repository protections remain untouched. Oxagen's checks govern merges
   requested through Oxagen, while repository permissions govern direct pushes and host merges.
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
callback, `GET /oauth/github/callback`. The callback checks the signature and the purpose. A state
it can't use never ends on JSON (#5151). An expired steering state goes through the landing below
with `code=state_expired`, and any other bad or foreign state goes to the result page with
`code=state_invalid` and no `return_to`. For a steering state it records the installation
id in the platform registry, exchanges the code with `GITHUB_APP_CLIENT_ID` and
`GITHUB_APP_CLIENT_SECRET`, stores the token, and sends the provision event again for each scope
that waits on a connection. It then redirects to the app's landing, `/github/steering`, with
`return_to` and `steering=connected`, or with `steering=error&code=<reason>` when a step after the
state check fails. The landing sends a member of the organization on to `return_to` with the same
query. A browser that can't open the organization, such as one signed in to another Oxagen account,
gets a result page that says how the install ended, never the organization's 404 (#5151). The start
route ignores the retired `app` parameter. `GET /oauth/github/steering` is gone and answers 404.

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
repo's settings when it happens. Provisioning needs none of these events. All five are among the 15 events in
[Webhooks](#webhooks):

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
4. Under **Permissions**, set exactly the list in [Permissions](#permissions). GitHub asks the owner
   of each existing installation to accept any permission you add. Until an owner does, that
   installation keeps its old permissions, and provisioning cannot create a repository through it.
5. Under **Subscribe to events**, check the 15 events in [Webhooks](#webhooks), and no others.
6. Ask an organization owner to install the app on the GitHub organization, on all repositories or
   on selected repositories, or to accept the new permissions on an installation it already has.

On the GitHub organization that holds steering repos, from its settings page on GitHub:

7. Open **Policies**, then **Repository**. If any repository policy turns on **Restrict
   creations**, add the Oxagen app under **Allow list**, **Apps**. Do the same for **Restrict
   visibility** if it leaves out private repositories, and for **Restrict names** if its patterns
   leave out `oxagen-config` and `oxagen-<workspace-slug>`. An enterprise can set these policies
   too, under its own **Policies**. GitHub refuses a create that a policy blocks with
   `422 Due to policy, you are not permitted to perform that operation on this repository.`, and
   provisioning stops at `create_repository` with `repository_create_refused`. On 2026-10-01 the
   `oxageninc` organization's policy "No Delete/Transfer" restricted creations to organization
   admins, and GTM's steering repo could not be created there.

### Moving from the Oxagen Steering app

The retired app is Oxagen Github Connect (`oxagen-github-connect`, App ID 5121606). A steering
connection made through it holds a token that app issued. The Oxagen app's
installations are invisible to that token, so provisioning stops with `steering_reauthorize`, and an
owner connects again from onboarding.

1. Install the Oxagen app on the same GitHub account the retired app was on. Select the steering
   repos the retired app created, or choose **All repositories**. An installation that cannot see a
   steering repo cannot mint a token for it.
2. Finish the connect. The callback replaces the retired installation id in the organization's
   steering connection and in each steering source connection. It moves an id only on the same
   account, because a GitHub App has one installation per account.
3. Repair each steering repo (`repair_steering_repo`). Review any existing rulesets in GitHub
   separately. Older repositories can still name the retired app as a bypass actor, and repair
   leaves those rulesets untouched. Update those actors before uninstalling the retired app.
4. Uninstall the retired app from the organization after the repair and ruleset review.
5. Once no account has it installed, delete it from its **Advanced** settings page. Deletion cannot
   be undone.

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

### Steering live test

The steering live test runs the whole steering repo path against production Oxagen and a GitHub
test organization (lane S11, #4723). It creates a workspace and waits for its steering repo to read
healthy. It merges a steering PR through Oxagen and reads a published version one higher. It then
allows merge commits on the repository, expects drifted health and a failed `Oxagen steering` check
within 60 seconds, repairs, and expects healthy again. The suite is in `apps/app/live/`, and the
workflow is `.github/workflows/steering-live.yml`. This section is its runbook.

| Part | Value |
| --- | --- |
| GitHub test organization | `ox-product` |
| Oxagen app | Oxagen Connect (`oxagen-connect`), installed on `ox-product` through the steering connect in step 2 below |
| Rig app | A second GitHub App, installed on `ox-product` on all repositories. Oxagen Github Connect Local (App ID 4055401) is installed there with every permission the rig uses. |
| Oxagen test account | A production Oxagen user that signs in with email and password. It is an Owner of the test Oxagen organization. |
| GitHub environment | `steering-live` on `oxageninc/product`. It allows only `main`. |

The rig app's token approves the steering PR, changes the merge settings, reads check runs, lists
the test organization's repositories, and deletes test repositories. It needs Administration and
Pull requests write, and Checks and Metadata read. The rig app can't be Oxagen Connect, because
GitHub refuses an app's approval of its own pull request.

The workflow reads these secrets and variables. `packages/config/src/ci-registry.ts` describes each
one and how to refresh it.

| Name | Kind | Where it lives |
| --- | --- | --- |
| `STEERING_LIVE_OXAGEN_EMAIL` | secret | `steering-live` environment |
| `STEERING_LIVE_OXAGEN_PASSWORD` | secret | `steering-live` environment |
| `STEERING_LIVE_GITHUB_APP_PRIVATE_KEY` | secret | `steering-live` environment |
| `STEERING_LIVE_GITHUB_APP_ID` | variable | repository |
| `STEERING_LIVE_GITHUB_ORG` | variable | repository, set to `ox-product` on 2026-10-02 |
| `STEERING_LIVE_OXAGEN_ORG` | variable | repository |
| `STEERING_LIVE_ENABLED` | variable | repository |

#### Setup

1. Create the Oxagen test account. In a private browser window, sign up at
   `https://app.oxagen.sh/signup` with an email you control and a password from
   `openssl rand -base64 24`. Verify the email and leave two-factor sign-in off, because the suite
   signs in with email and password alone. Create the test Oxagen organization. The account that
   creates it is its Owner, which lets it start the steering connect and merge a steering PR
   without an approving review.
2. Connect GitHub steering for the test organization. Still signed in as the test account, open
   `https://app.oxagen.sh/api/v1/<oxagen org>/connections/steering/github?mode=install&return_to=/<oxagen org>`.
   On GitHub, install Oxagen Connect on `ox-product` with **All repositories**, and authorize it.
   Oxagen returns through `/github/steering`, which sends a member of the organization on to it with
   `steering=connected`. A browser signed in to another Oxagen account gets the GitHub connection
   result page instead, and the connection is saved all the same. The install link expires 10
   minutes after it is made. An install that finishes later lands on the result page and saves
   nothing, so start the connect again. Don't start from Oxagen Connect's
   public install page: the callback refuses an install that carries no steering state. Authorize
   with a GitHub account that owns `ox-product` and no other organization that has Oxagen Connect,
   so the token Oxagen stores sees only the test organization.
3. Check the repository policies on `ox-product`, as step 7 of the [Setup checklist](#setup-checklist)
   says. They must let Oxagen Connect create private repositories named `oxagen-live-<run id>-<attempt>`.
4. Give the rig app a key for CI. On the rig app's settings page, generate a new private key. For
   Oxagen Github Connect Local, generate a key only CI holds, so deleting a developer's key never
   breaks the live test.
5. Save the values from a checkout of `oxageninc/product`. `gh secret set` prompts for each value,
   so no value lands in shell history. Delete the `.pem` file afterward.

   ```sh
   gh secret set STEERING_LIVE_OXAGEN_EMAIL --env steering-live
   gh secret set STEERING_LIVE_OXAGEN_PASSWORD --env steering-live
   gh secret set STEERING_LIVE_GITHUB_APP_PRIVATE_KEY --env steering-live < rig-app.pem
   gh variable set STEERING_LIVE_GITHUB_APP_ID --body '<rig app id>'
   gh variable set STEERING_LIVE_OXAGEN_ORG --body '<oxagen org slug>'
   ```

6. Dispatch a run with `gh workflow run steering-live.yml --ref main`. A run with a missing value
   fails in its first step and names each one. Run 37007573039 on 2026-10-02 named five.
7. After two dispatched runs pass in a row, set `STEERING_LIVE_ENABLED` to `true`. The workflow
   then also runs every day at 09:17 UTC.

#### Cleanup

Each run names its workspace `live-<run id>-<attempt>` and its steering repo
`oxagen-live-<run id>-<attempt>`. Before the suite, the sweep step archives any other workspace a
run left and deletes test repositories older than one day. After the suite, its teardown archives
the run's workspace and deletes its repository. The workflow's `always()` step does the same again,
for a run cancelled before its teardown.

#### Logs

The suite never prints a secret. An error names the request method, the path, the status, and at
most 500 characters of the response body. A failed sign-in names only the status and the error
code. Actions masks secret values in step logs, but not in the uploaded Playwright report.

#### Failures

When the drift test times out, read the run's last state first. The 60-second window depends on
GitHub sending a `repository` webhook for the merge-setting change. Without one, drift shows only
at the next 10-minute health sweep.

### MCP Studio live test

The MCP Studio live test runs MCP Studio end to end against production Oxagen and the same GitHub
test organization (lane M17, #5139). The suite is in `apps/app/live/` (`mcp-studio.live.ts`,
`mcp-studio-rig.ts`, and `mcp-studio-servers.ts`), and the workflow is
`.github/workflows/mcp-studio-live.yml`. This section is its runbook.

The job starts four sample servers on the runner from M0's fixtures in
`packages/mcp-studio/fixtures/`:

| Server | Fixture | How Oxagen reaches it |
| --- | --- | --- |
| `live_mcp`, an MCP server | `mcp/tools-list.json` | A public tunnel |
| `live_payments`, an OpenAPI service | `openapi/openapi-3.1.yaml` | A public tunnel |
| `live_desk`, a GraphQL service | `graphql/schema.graphql` | A public tunnel |
| `live_ledger`, a gRPC service | `grpc/ledger.proto` | A relay (`apps/relay`) |

Production refuses a private address, so the job opens a Cloudflare quick tunnel
(`cloudflared tunnel --url`) to the runner. A quick tunnel needs no account. The workflow pins the
`cloudflared` version and checks its SHA-256. Each request through the tunnel must carry a bearer
token the workflow makes for the run, and the suite stores that token as the workspace credential
`mcp-live-upstream`. The gRPC service listens on the runner only. The suite registers a relay named
after the run and starts it with the key Oxagen signs relay calls with, which the host enrollment
returns.

The suite runs seven tests in order, in one worker:

1. Create the workspace `mcp-live-<run id>-<attempt>`, store the credential, enroll a host, and
   connect the relay.
2. For each server, save a Studio draft that imports and classifies two tools, open its steering
   PR with Review, and wait for the repository to read healthy.
3. Merge each steering PR through Oxagen and read a higher published version.
4. Publish the test agent's file and two Cedar policies: one parks every irreversible call for
   approval, and one forbids the test agent the MCP server's `create_issue`.
5. Call each tool through `https://mcp.oxagen.sh/mcp` with the host's gateway key. Six calls
   return shaped results. `live_payments__create_payment` parks for approval, and
   `live_mcp__create_issue` is denied and hidden. Neither reaches its upstream.
6. Change `list_repositories`'s description on the sample MCP server and run a discovery. Expect a
   sync steering PR, with the locked description still served.
7. Revoke the relay, wait for the broker to close its connection, and expect the next gRPC call to
   fail without reaching the upstream.

The job reads the same secrets and variables as the steering live test, in the same `steering-live`
environment, and no others. It makes the upstream token and the tunnel URL for each run.
`STEERING_LIVE_ENABLED` turns on both schedules. The two workflows share the `steering-live`
concurrency group, so they never run at the same time.

#### Product gaps

Two steps wait on Oxagen capabilities that do not exist yet. The rig fails each with its issue's
number, so the run stops there and says why.

- **#5122.** Oxagen can't merge a steering PR that has no proposal: a Studio Review, a sync, or a
  Markdown import. A merge on GitHub would leave the steering repo `diverged`. Test 3 stops here,
  and every later test fails because nothing published.
- **#5149.** Nothing in Oxagen writes an agent file (`agents/<name>.toml`). Without one, the gateway
  matches no agent to the host and serves no tool.

When either lands, fill in `mergeSteeringPullRequest` or `publishAgentFile` in
`apps/app/live/mcp-studio-rig.ts`.

#### Setup

The steering live test's setup above covers this suite too, with one more condition: the test
Oxagen organization must have governed actions left. The gateway refuses every served call when
the organization's units run out. The suite's relay names no credential, so it runs on any plan.
Only a relay credential needs Enterprise.

Dispatch a run with `gh workflow run mcp-studio-live.yml --ref main`. Lane M17 is done after two
dispatched runs pass in a row.

#### Cleanup

Each run names its workspace `mcp-live-<run id>-<attempt>` and its steering repo
`oxagen-mcp-live-<run id>-<attempt>`. The sweep and the cleanup steps run
`live/steering-cleanup.ts` with the suite name `mcp-studio`, so they touch only this suite's
workspaces and repositories, never the steering live test's. A relay or a host enrollment a failed
run left stays in the archived workspace, where nothing routes to it. A host enrollment expires
after one day.

#### Logs

The suite never prints a secret. The sample servers and the relay log no token. When the suite
fails, the workflow prints the sample servers' log, the tunnel's log, and the control port's status,
which lists every call each upstream received and every event the relay logged.

#### Failures

- A tunnel that never reaches the sample servers fails its own step. Cloudflare's quick tunnels have
  no uptime promise, so dispatch the run again.
- A relay that logs `untrusted_key` trusts a key other than the one the MCP service signs with. The
  suite takes the key from the host enrollment, which the API service answers. Both services read
  `TACHO_BUNDLE_SIGNING_PRIVATE_KEY`, so this means the two hold different values.
- Test 7 waits up to 90 seconds for the relay to log `token_revoked`, or a disconnect with code
  4001, because the broker re-checks each relay's token every 30 seconds.

---

## Known gaps / follow-ups

Resolved in code (kept here for history):

- ✅ **App-level webhook receiver**: `POST /webhooks/github/app` resolves connections from the
  payload's `installation.id` + `repository.full_name`.
- ✅ **`GITHUB_APP_WEBHOOK_SECRET` wired**: used for HMAC verification on the App-level route.
- ✅ **Event-name → record-type mapping**: `github.parseWebhookEvent()` translates and unwraps each
  event (incl. `push` → per-commit fan-out).
- ✅ **`installation` / `installation_repositories` handling**: acked; uninstall/suspend pauses the
  installation's connections.
- ✅ **Status-constraint bug**: activation now writes `connected` (was the invalid `active`, which
  violated `source_connections_status_check`).
- ✅ **Setup URL landing route**: implemented at **`/github/setup`**
  (`apps/app/src/app/github/setup/route.ts`), kept for older registrations (ADR-228); resolves the membership-gated workspace and the wizard
  recovers the in-progress connection via a sessionStorage handoff so it resumes Step 2 (not Step 1).
  `/installations` + `/repositories` fall back to (and link) the org's GitHub OAuth account when the
  Setup-URL "update" leg left the connection unlinked.

Still open:

1. **Installation-token auth**: move unattended sync off the user token onto GitHub App installation
   access tokens (JWT signed with the App private key), so sync survives the authorizing user leaving.
2. **Webhook receipt bookkeeping**: optionally stamp `last_sync_at` / a `webhook_subscriptions`
   row on delivery for observability (functional sync does not require it).
3. **Canonical topology + evidence**: derive shared topology only from a configured
   protected/default ref, and add a typed evidence ledger for verified execution-to-commit,
   artifact, test, and changed-file claims. Do not restore source-blob ingestion to deliver this.
