# ADR-215: The production app moves to oxagen.app

- **Status:** Accepted
- **Date:** 2026-09-28
- **Owners:** deploy
- **Related:** issue #4655, PRs #4631 and #4641 (`oxagen.app` as a vanity
  redirect), infra/README.md ("`oxagen.app` is the app's domain"), ADR-083
  (the client address Caddy forwards).

## Context

The production web app answers at `https://app.oxagen.sh`. Route 53 holds the
`oxagen.sh` zone, the ALB terminates TLS, and Caddy on the app node routes
each hostname to its Node process.

Mac bought `oxagen.app` on 2026-09-27. It is registered at Vercel, in the team
with slug `oxagen-inc`, which Mac moved to from an earlier Vercel team. PRs
#4631 and #4641 brought it into Route 53 as a vanity domain: a CloudFront
distribution answers it with a 302 to `https://app.oxagen.sh/`, and an ACM
certificate for `oxagen.app` and `www.oxagen.app` is issued in us-east-1. The
`.app` registry has listed the zone's Route 53 nameservers since 06:35 UTC on
2026-09-28.

Mac now wants the app served at `oxagen.app`, with `app.oxagen.sh`
redirecting to it.

The app's origin reaches production by two routes. `NEXT_PUBLIC_APP_URL` is
inlined at build from `APP_PROD_URL` in `packages/config/src/registry.ts`.
`BETTER_AUTH_URL` and `APP_URL` are read from Parameter Store under
`/oxagen/production` when the container starts, and nothing in this repository
writes them.

Programs call `app.oxagen.sh` as well as people. SCIM clients send a bearer
token, identity providers post SAML responses, OAuth providers return to the
callback they have on file, and Stripe and GitHub deliver webhooks. A fetch
drops its `Authorization` header when a redirect crosses origins, and a POST
does not survive a redirect.

`infra/tools/caddy/Caddyfile.alb` reaches the node only when someone runs
`infra/tools/install-node-scripts.sh` with credentials for account
`916294258235`. No CI job installs it.

## Decision

1. **`oxagen.app` leaves the vanity set.** `moved` blocks in
   `infra/stacks-new/oxagen/dns-oxagen-app.tf` carry its zone, mail records,
   CAA record, certificate, and validation records out of
   `dns-vanity-domains.tf` unchanged. The zone keeps the nameservers the
   registry names, and the certificate stays issued. The CloudFront redirect
   is destroyed.
2. **The ALB serves the name.** The certificate joins the HTTPS listener
   beside the `app.oxagen.sh` one, and the apex and `www` records alias the
   ALB.
3. **Until the cutover, the ALB redirects.** A listener rule answers
   `oxagen.app` and `www.oxagen.app` with a 302 to the same path and query on
   `app.oxagen.sh`, the job CloudFront did. The change therefore needs no
   manual step to merge safely.
4. **One process answers on all three names.** `Caddyfile.alb` routes
   `oxagen.app`, `www.oxagen.app` and `app.oxagen.sh` to the app.
5. **The app sends page visits to the canonical host.**
   `canonicalHostRedirect` in `apps/app/src/shared/canonical-host.ts` reads the
   canonical host from `NEXT_PUBLIC_APP_URL`. `redirectToCanonicalHost` sends
   the redirect from `navigation.ts`, the one module that sends the app's
   redirects (`apps/app/ARCHITECTURE.md` §3.8). A GET or HEAD for a page on one
   of the other two names moves to the same path and query there, before the
   session gate runs. Paths under `/api/` and `/.well-known/` answer on every
   name, and so does every other method. A redirect to `oxagen.app` is a 308
   cached for an hour. A redirect to any other host is a 307 with `no-store`,
   so a browser that saw one before the switch cannot replay it afterwards and
   loop.
6. **The cutover is one PR and Mac's Parameter Store and OAuth changes.** It
   sets `APP_PROD_URL` to `https://oxagen.app`. The listener rule is deleted
   before it, in a PR of its own (amendment of 2026-09-29). From its deploy, `app.oxagen.sh` answers page visits with a 308 to
   `oxagen.app`. Better Auth trusts both origins, so sign-in holds while the
   build and Parameter Store disagree.

## Rollout

| Step | Who | What |
|---|---|---|
| 1 | CI | The PR that adds this record merges. `infra.yml` moves `oxagen.app` out of the vanity set, adds its certificate to the ALB, and points both names at the ALB. `oxagen.app` keeps redirecting to `app.oxagen.sh`, now from the ALB. |
| 2 | Mac | Run `infra/tools/install-node-scripts.sh`, so Caddy routes `oxagen.app` and `www.oxagen.app` to the app. |
| 3 | Mac | Add `https://oxagen.app` redirect URIs to the Google sign-in client, Linear, and each preregistered MCP client, and set the GitHub App's Setup URL to `https://oxagen.app/github/setup`. The API serves the GitHub App's callback and webhook, so they follow the API (step A3). |
| 3a | Agent | Delete the listener rule in its own PR, and confirm `infra.yml` applied it before step 4 merges. A page visit on `oxagen.app` then gets a 307 to `app.oxagen.sh` from the app instead of a 302 from the ALB. |
| 4 | Agent | Open the cutover PR: `APP_PROD_URL` and the `app.oxagen.sh` fallbacks in code become `https://oxagen.app`, and links and deploy probes move to `oxagen.app`. |
| 5 | Mac | After the cutover PR merges and before its `deploy app.oxagen.sh` job starts, set `BETTER_AUTH_URL`, `APP_URL`, `NEXT_PUBLIC_APP_URL`, and `OAUTH_PROXY_PRODUCTION_URL` under `/oxagen/production` to `https://oxagen.app` where they exist. Add it to `BETTER_AUTH_TRUSTED_ORIGINS` if that exists. Move the GitHub sign-in OAuth app's one callback URL to `https://oxagen.app/api/auth/callback/github`. |

This command lists the Parameter Store values step 5 changes:

```bash
aws ssm get-parameters --with-decryption \
  --names /oxagen/production/{BETTER_AUTH_URL,APP_URL,NEXT_PUBLIC_APP_URL,BETTER_AUTH_TRUSTED_ORIGINS,OAUTH_PROXY_PRODUCTION_URL} \
  --query 'Parameters[].[Name,Value]' --output text
```

The deploy starts each container with the new build and the new values
together. A container that restarts between step 5 and that deploy would run
the old build with the new values, and sign-in would fail on it until the
deploy lands.

## Alternatives

- **Request a new certificate.** The redirect's certificate already covers
  both names and is issued. Adopting it avoids a second validation and keeps
  the zone's validation records under one owner.
- **Add the names to the existing certificate.** A new name on
  `aws_acm_certificate.app` replaces the certificate every `oxagen.sh` host is
  served with.
- **Keep the CloudFront redirect until the cutover.** The cutover would then
  change DNS, the ALB, and the build in one step. Moving DNS first puts the
  name's new path, from DNS through the ALB's certificate, into service while
  it still only redirects, so the cutover changes only the build.
- **Redirect `app.oxagen.sh` at the ALB or in Caddy.** An ALB rule answers
  only 301 or 302, and it would start redirecting minutes after the merge,
  while the deploy that changes the app's origin waits for the full test run.
  A Caddy rule waits for the next manual install. The app's proxy ships in the
  same build that changes its origin, and its unit tests cover the paths that
  must not move.
- **Redirect everything on `app.oxagen.sh`.** Installed clients would lose
  their `Authorization` header, and every webhook, SAML POST, and registered
  OAuth callback would fail until each one was changed.

## Consequences

- **`app.oxagen.sh` stays in service.** It answers the API, auth, SCIM, and
  well-known paths for as long as a client, identity provider, or webhook
  calls it there. Its DNS record, certificate name, and Caddy route stay until
  a later record retires them.
- **Everyone signs in once more.** Session cookies belong to the host that
  set them, so a session on `app.oxagen.sh` does not follow a visitor to
  `oxagen.app`.
- **SAML providers set up against `app.oxagen.sh` need checking.** The SSO
  callback, ACS URL, and entity ID the app shows are built from
  `BETTER_AUTH_URL` (`packages/handlers/src/lib/sso.ts`), so they name
  `oxagen.app` after step 5. Check each provider set up before it against its
  identity provider.
- **`oxagen.app` loses IPv6.** The CloudFront redirect had AAAA records. The
  ALB has no IPv6 address, the same as for `app.oxagen.sh`.
- **The mail records stay.** `oxagen.app` keeps the null MX, `v=spf1 -all`,
  and `p=reject` DMARC records it had as a vanity domain. Remove all three
  together if the app starts sending mail from it.

## Amendment 2026-09-28: the API moves to api.oxagen.app

Mac decided on 2026-09-28 that the API is served at `api.oxagen.app` (#4709).
The record above moved only the web app. The next amendment moves MCP and the
docs.

- **Both names answer.** `api.oxagen.app` serves the API beside
  `api.oxagen.sh`, and neither redirects to the other. A webhook POST and an
  `Authorization` header do not survive a redirect, so `api.oxagen.sh` stays
  for the CLIs, webhooks, and OAuth callbacks that call it until a later
  record retires it.
- **The name has its own certificate.** `dns-oxagen-app.tf` issues one for
  `api.oxagen.app` and adds it to the ALB's HTTPS listener. A new name on
  `aws_acm_certificate.app` or `aws_acm_certificate.oxagen_app` would replace
  a certificate the ALB serves.
- **Caddy routes both names to the API.** Until `Caddyfile.alb` is installed
  with the new name, Caddy answers `api.oxagen.app` with a 404.

| Step | Who | What |
|---|---|---|
| A1 | CI | The PR that adds this amendment merges. `infra.yml` issues the `api.oxagen.app` certificate, adds it to the ALB, and points the name at the ALB. |
| A2 | Mac | Run `infra/tools/install-node-scripts.sh` after A1, even if step 2 already ran. Then `curl -s https://api.oxagen.app/health` answers from the API. |
| A3 | Mac | Once A2's check answers, set the `oxagen-connect` GitHub App's webhook URL to `https://api.oxagen.app/webhooks/github/app`, and put `https://api.oxagen.app/oauth/github/callback` first in its Callback URLs with `https://api.oxagen.sh/oauth/github/callback` after it. The code passes GitHub no `redirect_uri`, so every connect returns to the first Callback URL. Do the same for the Oxagen Steering app with `/oauth/github/steering`. |
| A4 | Agent | Open the API cutover PR: `API_PROD_URL`, `DEFAULT_API_ORIGIN`, the docs, the CLI, and the desktop app name `https://api.oxagen.app`, and the deploy probes check it. |

## Amendment 2026-09-28: MCP and the docs move to oxagen.app

Mac decided on 2026-09-28 that MCP and the docs move to `.app` too (#4717).
`mcp.oxagen.app` serves the MCP server and `docs.oxagen.app` serves the docs,
on the terms of the API amendment above.

- **Both names answer.** Neither name redirects to the other. An MCP client
  sends its key in an `Authorization` header, which a redirect drops, so
  `mcp.oxagen.sh` stays for the clients configured with it until a later record
  retires it.
- **Each name has its own certificate.** `dns-oxagen-app.tf` issues one for
  each name and adds both to the ALB's HTTPS listener. Either name can leave
  the ALB without replacing a certificate the other is served with.
- **Caddy routes both names.** `@mcp` and `@docs` in `Caddyfile.alb` match the
  `.sh` and the `.app` name. Until the file is installed with them, Caddy
  answers both `.app` names with a 404.
- **No code change is needed to answer.** The MCP server pins no Host header
  and publishes no OAuth metadata that names its origin. The docs site has no
  canonical-host redirect.
- **The docs keep their canonical name until B3.** The sitemap, `llms.txt`, and
  the `oxagen.dev` redirect (`variables.tf`) name `docs.oxagen.sh`. B3 moves
  them after `docs.oxagen.app` answers.

| Step | Who | What |
|---|---|---|
| B1 | CI | The PR that adds this amendment merges. `infra.yml` issues both certificates, adds them to the ALB, and points both names at the ALB. |
| B2 | Mac | Run `infra/tools/install-node-scripts.sh` after B1. One run after B1 also covers A2. Then `curl -sI https://docs.oxagen.app/` returns 200, and a `POST` to `https://mcp.oxagen.app/mcp` returns the status the same request gets from `mcp.oxagen.sh`. `/healthz` proves nothing, because Caddy answers it for every name. |
| B3 | Agent | Open the MCP and docs cutover PR: `MCP_PROD_URL`, the docs sitemap and `llms.txt`, the `oxagen.dev` redirect target, the install instructions, the docs pages, and the deploy probes in `pipeline.yml` name the `.app` origins. |

## Amendment 2026-09-29: the listener rule goes before the cutover

The Rollout first had the cutover PR delete the listener rule. That PR also
changes the build, and the two reach production by different routes.
`infra.yml` applies a change under `infra/stacks-new/` on its own trigger, and
`pipeline.yml` deploys the app. Neither waits for the other. If the new build
went live while the rule still stood, `app.oxagen.sh` would answer a page
visit with a 308 to `oxagen.app`, and the rule would answer that with a 302
back. A browser caches the 308 for an hour, so it would loop for that hour.

So the rule is deleted first, in a PR of its own (step 3a). Nothing a visitor
sees changes: the build still in production treats `app.oxagen.sh` as
canonical, so it answers a page visit on `oxagen.app` or `www.oxagen.app` with
a 307 to the same path on `app.oxagen.sh`, uncached. Paths under `/api/` and
`/.well-known/` start answering on `oxagen.app` instead of redirecting, and
Better Auth already trusts that origin. The cutover PR merges only after
`infra.yml` has applied the deletion.
