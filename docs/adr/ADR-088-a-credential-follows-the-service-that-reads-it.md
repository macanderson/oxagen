# ADR-088: A credential follows the service that reads it, and `apps/app` reads the GitHub App's private key

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, app
- **Related:** ADR-089 (an on-demand read lives in a `"use server"` module — the
  kernel seam is the only route from `apps/app` to `invoke()`), ADR-020
  (per-workspace GitHub write credentials), ADR-042 (data planes), ADR-053 §1
  (the engine is a separate container the app reaches over loopback),
  `packages/config/src/registry.ts` (the environment contract),
  `tools/scripts/build-env.ts` (what `services[]` provisions),
  `apps/app/src/server/kernel.ts` (the seam),
  `packages/handlers/src/repository.main.get.ts` (`REQUIRED_GITHUB_APP_ENV`),
  `packages/handlers/src/repository.github-user-installations.ts`
  (`GITHUB_TOKEN_DECRYPT_ENV`),
  `packages/handlers/src/repository.github-env.test.ts` (the check)

## Context

`packages/config/src/registry.ts` is this repo's environment contract. Each
variable names the services that need it, and `tools/scripts/build-env.ts`
renders a service's build environment strictly from that list:

```ts
for (const [key, meta] of Object.entries(ENV_REGISTRY)) {
  if (!meta.services.includes(service)) continue;
```

Nine variables behind the GitHub repository flow named `api` (two of them also
`mcp`) and not `app`:

| variable | read by |
|---|---|
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_INSTALL_STATE_SECRET`, `GITHUB_APP_CLIENT_SECRET` | `envGithubUrls`, minting and gating the three GitHub doors |
| `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` | `getInstallationToken` in `repository.main.bind.ts` and `repository.installation.list.ts`; `resolveGitHubToken` in `packages/github/src/workspace-token.ts` |
| `INGESTION_ENCRYPTION_KEY`, `AWS_KMS_INGESTION_KEY_ARN`, `INGESTION_CRYPTO_PROVIDER` | `resolveWorkspaceGithubUserToken`, opening the stored OAuth envelope |

All of those run **inside `apps/app`**. The app reaches every capability
in-process: `apps/app/src/server/kernel.ts` calls `invoke()` directly, and
ADR-089 makes that seam the only route to it. So the declaration said the app
needs none of these while the app is where they are read.

It had been wrong longer than the branch that found it. `commit_agent_definition`
is invoked from `apps/app/src/features/agents/actions.ts` on `main` today and
reaches the same credentials through `resolveGitHubToken`. PR #3233 made the gap
visible by adding five more app-invoked capabilities on the same path; it did
not introduce it.

### What the wrongness actually cost, stated carefully

The first account of this defect was that the feature was dead in production.
That account is too strong, and the correction matters enough to record, because
an ADR that overstates a failure teaches the wrong lesson about where the
boundary is.

`services[]` governs the **build** environment. The runtime environment on this
topology is assembled elsewhere: `infra/tools/node/deploy-service.sh` reads
`aws ssm get-parameters-by-path --path /oxagen/production --recursive` and
exports **every** parameter it finds into the container as `-e KEY`, with no
registry filter, and `tools/scripts/package-for-node.sh` gives `app` the same
`config_prefix: /oxagen/production` it gives `api`. On that reading the running
app container already holds these values, and the handlers read them at request
time through `process.env[...]`, which no bundler inlines.

**This was read from the deploy scripts in the tree; it was not observed on a
running instance.** It is recorded as what the scripts say, not as a guarantee
about production. If the topology has since changed — a per-service prefix, a
different runner, a filtered injection — the guarantee is gone and the
declaration is the only thing left standing.

That is the whole argument for fixing it anyway. The environment contract is
meant to be the answer to "what does this service need". A contract that is
wrong and survives only because something downstream ignores it is a trap: the
day anything honours it, the connect flow dies, and it dies **quietly**.
`REQUIRED_GITHUB_APP_ENV` is all-or-nothing by design, so one missing variable
renders the same "not configured for this deployment" screen as a deployment
that deliberately has no GitHub App — no error naming the variable. A token
whose adapter is unreachable comes back `{ ok: false, reason: "unreadable" }`,
which reads as a broken connection.

## Decision

**A credential is registered for every service that reads it. `apps/app` reads
the GitHub App's private key, so the key names `app`.**

The nine variables above gain `"app"` in their `services[]`. The private key and
the App id now name three services (`api`, `mcp`, `app`); the rest name two.

This is not new policy. `STRIPE_SECRET_KEY` has been `["api", "app"]` for the
same reason: a secret genuinely read in-process by an `apps/app` handler belongs
in that service's environment, exactly as it belongs in api's. What is new is
saying so where a security reviewer will look for it, because "why does the web
app hold the GitHub App private key" is a question that deserves an answer on
file rather than a re-derivation.

### The rejected option: route these capabilities through the API

The alternative is that `apps/app` never holds the key — the three
token-minting capabilities are called over HTTP against `apps/api`, which holds
it alone. On its face that is the stronger boundary, and an installation token
is the most dangerous thing in this flow: it authorizes against the customer's
GitHub and, as this PR's own security work established, **carries no caller
entitlement at all** — GitHub asks who the App is, not who asked.

It was rejected on four findings, in order of weight.

**1. The boundary it buys is illusory on this topology.** `app` and `api` are
two processes on one 8 GB instance (`pipeline.yml`'s deploy matrix says so in
those words, and serialises the matrix because of it), under one IAM role:
`infra/stacks-new/oxagen/crypto.tf` grants `kms:Decrypt` on the ingestion key to
`module.app.role_name`, shared. And `app` already holds `BETTER_AUTH_SECRET`,
`DATABASE_URL`, `STRIPE_SECRET_KEY` and `AUDIT_EXPORT_SIGNING_SECRET`. With
`BETTER_AUTH_SECRET` alone, an attacker in the app mints a session for any org
Owner and asks `api.oxagen.sh` to mint installation tokens on their behalf. The
API would hand them over, because that is what the API is for. Withholding the
key from the app withholds nothing from anyone who has the app.

**2. There is no app→api HTTP path in this repo to route through.** Not one
capability. The single outbound service call `apps/app` makes is to
`stella-serve` over loopback (ADR-053 §1). Routing three capabilities would
introduce a transport that exists for nothing else, for three capabilities,
against ADR-089's "the kernel seam is still the only path to `invoke()`".

**3. It would need user-identity forwarding, which is a worse credential.**
These handlers gate on `assertOrgRole` against the acting user, so the hop
cannot be a service call — it has to carry *who asked*. That means forwarding
the session or minting a service credential able to act as any user. A token
that impersonates arbitrary Owners is a strictly larger blast radius than a key
that mints installation tokens, and it would live in the app either way.

**4. It would lose the typed refusals the UI depends on.** `classifyKernelFailure`
keys on the error's `code` property and `workspace-settings-failure.ts` gives
every one of those codes its own sentence. Over HTTP those codes have to be
reconstructed from status and body, which is a second classification to keep in
agreement with the first — the same "two things that must agree and are not made
to" shape that produced several of this PR's defects.

The honest cost of the decision it leaves standing: **the private key now sits in
two services' declared environments instead of one.** That is judged acceptable
because finding 1 says the second service already has it in fact, and findings
2–4 say the alternative buys a new transport, a worse credential and a duplicated
error taxonomy in exchange. If the topology ever separates — different hosts,
different roles, a per-service parameter prefix — finding 1 stops holding, and
this ADR should be revisited rather than cited.

### The rule is enforced by a test, not by care

`packages/handlers/src/repository.github-env.test.ts` asserts that every name in
`REQUIRED_GITHUB_APP_ENV` and in `GITHUB_TOKEN_DECRYPT_ENV` carries both `api`
and `app` in its registry entry.

It iterates **the constants the handlers themselves read** rather than a literal
list of the nine names. `envGithubUrls` gates on the first; the second names the
providers `resolveWorkspaceGithubUserToken` may have to open an envelope with. A
variable added to this flow has to join one of those lists to take effect at
all, and the moment it does, the test holds it to the registry. A test spelling
out today's nine names would pass over the tenth — which is precisely how this
one got in.

**`pnpm env:check` does not cover this and a green one must not be read as if it
does.** `tools/scripts/env-check.ts` builds a `registryServiceMap` and uses it
for the opposite direction only: its *dead declarations* pass reports a variable
whose `services[]` is non-empty and which no source file references. A variable
referenced by code that runs in `app` while declaring only `api` **is**
referenced, so it is not dead, so env-check reports it clean. It reported this
exact defect clean for as long as it existed. That sentence is in the test file's
header for the next person.

## Consequences

- The nine variables need no new provisioning: `/oxagen/production` is a single
  shared prefix that `api` already populates, so this is a declaration change
  and not an operational one. `pnpm env:check` passes and `.env.example`
  regenerates without drift.
- `REQUIRED_GITHUB_APP_ENV` is now exported, and `GITHUB_TOKEN_DECRYPT_ENV` is
  new. Both are read by the code and by the test, so neither can drift from what
  is actually required without the test noticing.
- `GITHUB_APP_CLIENT_SECRET` reaches a service that never uses its *value* —
  only `api`'s public callback exchanges the code with it. `envGithubUrls` reads
  it as a presence check, because offering a Connect that the callback will
  answer with a 503 strands the operator on a GitHub page with nothing on our
  side to explain it. A boolean "the connect is configured" flag would keep the
  secret out of the app at the price of a second source of truth that drifts
  from the first, which is the trade this repo keeps declining.
- `GITHUB_PERSONAL_ACCESS_TOKEN` deliberately stays `["api"]`. Its own
  description forbids it in production — a shared PAT bypasses per-workspace
  scoping — and local development loads the root `.env.local` regardless of
  `services[]`, so nothing needs it here.
- `mcp` is not added to the seven variables that lack it, and the test does not
  require it. It runs the kernel too, but no MCP tool surfaces the settings
  dialog's capabilities; requiring it would assert a promise nothing makes. The
  test's assertion is a superset check, so a variable that names `mcp` as well
  still passes.
- The correction in Context — that `services[]` is the build contract and the
  deploy script ignores it at runtime — is worth acting on separately. A
  per-service runtime injection would make the environment contract mean what it
  says, and would have turned this defect into a startup failure instead of a
  blank screen. That is a change to `deploy-service.sh` and out of scope here.

## Why this is an ADR rather than a comment

SCR-002. Without a record, the next reader to notice that the web app holds the
GitHub App private key will "fix" it by building the app→api transport — and on
findings 1–4 that is actively worse than what it replaces: it adds a
user-impersonating credential and a second error taxonomy to buy a boundary that
one shared instance, one IAM role and `BETTER_AUTH_SECRET` have already
dissolved. The registry entries carry a sentence each about why they name `app`;
they cannot carry the argument against the alternative, and the alternative is
the thing someone will reach for.
