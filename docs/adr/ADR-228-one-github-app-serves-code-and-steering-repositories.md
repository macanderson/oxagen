# ADR-228: One GitHub App serves code and steering repositories

- **Status:** Accepted
- **Date:** 2026-09-29
- **Owners:** steering, repositories
- **Amends:** ADR-212 (point 9), ADR-215 (step 3 and step A3)
- **Related:** issue #4753, issue #4634,
  `docs/specs/github-app/github-app-setup.md`,
  `docs/specs/repository-binding/README.md`.

## Context

Steering repos ran on a second GitHub App, Oxagen Steering. It held
Administration and Deployments write, so an installation on code repositories
never held either. Its connect returned to its own callback,
`/oauth/github/steering`, and it read six `OXAGEN_STEERING_APP_*` variables,
its webhook secret among them.

GitHub constrains how a connect returns:

1. `installations/new` takes no `redirect_uri`. An install returns to the
   app's first Callback URL, whatever else the list holds.
2. GitHub turns the Setup URL off while **Request user authorization (OAuth)
   during installation** is on. **Redirect on update** does nothing without a
   Setup URL.
3. When an organization already has the app, the install page shows
   **Configure**, drops the state, and returns no code.

So each app needs its own callback route, credentials, and webhook secret, and
an owner has to install both apps and can install one without the other.
Production never registered the second app (#4634), and steering onboarding
stopped there.

## Decision

1. **One app per environment.** The Oxagen GitHub App serves code repositories
   and steering repos. Steering reads `GITHUB_APP_ID`,
   `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`,
   `GITHUB_APP_CLIENT_SECRET`, and `GITHUB_APP_INSTALL_STATE_SECRET`. The app
   adds **Administration: Read and write** and **Deployments: Read and write**
   and subscribes to `repository_ruleset` and `branch_protection_configuration`.
2. **One callback.** Every connect returns to `/oauth/github/callback`, and no
   URL Oxagen builds carries a `redirect_uri`. The state is HMAC-signed and
   names its purpose. A steering state completes the steering connect. A state
   signed for any other purpose gets 400. `/oauth/github/steering` is removed
   and answers 404.
3. **Install first, then authorize.** Onboarding shows one GitHub card with two
   links. `mode=install` installs the app and authorizes the owner in one pass.
   `mode=authorize` serves an organization that already has the app, because
   GitHub drops the state on **Configure**. The start route ignores the retired
   `app` parameter.
4. **The Setup URL stays blank.** A no-state install records its installation
   id and lands on `/?github_installed=1`. The `installation` webhook enriches
   the record.
5. **One webhook secret.** `GITHUB_APP_WEBHOOK_SECRET` verifies the app's
   deliveries. A verified delivery that can change a steering repo's settings
   asks for a health read before the installation lifecycle and ingestion run.
   A failure to ask is logged and never fails the delivery.
6. **`create_github_token` refuses the steering repo outright.** It returns
   `steering_repo_propose_only` before it reads an installation, because every
   token the one app mints carries the merge ruleset's bypass.
7. **The settings baseline names the configured app.** The required-check
   integration, the `Oxagen merges` bypass actor, `deployed_by`, and
   `merge_access` resolve to the configured App ID.

## Consequences

- **Administration write reaches every repository an installation covers.**
  An installation on all repositories lets the app change settings on code
  repositories too. Oxagen calls those endpoints only from the steering repo
  code paths.
- **The app that holds the bypass issues every installation token.** Four
  paths mint a token scoped to the whole installation, and a steering repo in
  that installation is inside the token's reach. No agent receives any of
  them, but an Oxagen defect on these paths could write to a steering repo
  past its check:
  - `packages/github/src/workspace-token.ts` (`resolveGitHubToken`)
  - `packages/handlers/src/repository.bound.ts`
  - `packages/handlers/src/repository.installation.list.ts`
  - `packages/handlers/src/repository.binding-write.ts`
- `packages/handlers/src/context.governance_mode.set.ts` writes straight to a
  repository's default branch, and `packages/handlers/src/run-issue-provider.ts`
  can create an issue on any repository the installation covers. Both use a
  token that can reach a steering repo.
- The tacho export already refuses the steering repo.
- **Existing connections move.** A steering connection made through the retired
  app holds a token that cannot see the Oxagen app's installations, so its
  provisioning stops with `steering_reauthorize` until an owner connects again.
  The organization also stores the retired app's installation id. When the
  owner connects again and installs the Oxagen app on the same GitHub account,
  the callback replaces that id in the organization's steering connection and
  in every steering source connection (`moveSteeringInstallation`). A GitHub
  App has one installation per account, so the old id on that account is dead.
  The callback never moves a connection to another account. The owner must
  give the Oxagen app's installation the steering repos the retired app
  created, or choose All repositories, or the mint for them fails.
  A steering repo the retired app set up names that app in its rulesets, so its
  health read reports drift until `repair_steering_repo` applies the settings
  again.
- **Each existing installation must accept the new permissions.** Until an owner
  accepts, that installation keeps its old permissions, and provisioning cannot
  create a steering repo through it.
- **Parameter Store keeps the retired variables until the deploy.** Delete the
  `OXAGEN_STEERING_APP_*` parameters under `/oxagen/production` after the
  deploy that carries this change. Nothing reads them.

## Alternatives

- **Keep two apps and give the second its own callback.** It works, and it is
  what #4634 set out to register. It keeps two installs per organization, two
  sets of credentials, and two webhook secrets, and it keeps the failure where
  an owner installs one app and not the other. The narrower permission split is
  its one benefit, and the bypass risk above is already bounded to Oxagen's
  own server-side code.
- **One app with a Setup URL for the steering leg.** GitHub turns the Setup URL
  off while OAuth during installation is on, and the connect needs the owner's
  user token, so this cannot return a code.
- **Scope every installation token to the repositories it needs.** It closes
  the exposure above at its root. It touches every token path and their tests,
  so it is its own change.
