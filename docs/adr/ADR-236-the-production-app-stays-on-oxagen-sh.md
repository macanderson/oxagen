# ADR-236: The production app stays on oxagen.sh

- **Status:** Accepted
- **Date:** 2026-09-30
- **Owners:** deploy
- **Supersedes:** [ADR-215](./ADR-215-the-production-app-moves-to-oxagen-app.md)
- **Related:** issue #4882, #4864 (the cutover revert), #4865 (the go-live
  checklist).

## Context

ADR-215 moved the production web app to `oxagen.app` and, by its amendments,
the API, MCP, and the docs too. The groundwork shipped: `api.oxagen.app`,
`mcp.oxagen.app`, and `docs.oxagen.app` answer with their own certificates,
and the ALB serves `oxagen.app` and `www.oxagen.app` (#4659, #4710, #4718,
#4789). The cutover itself (#4798) was reverted by #4864 before any deploy
carried it, so `app.oxagen.sh` never stopped being canonical.

The cutover still needed a new Google sign-in client, a moved GitHub sign-in
callback, every third-party app registered for both hosts, and a window to
switch the Parameter Store origins. Oxagen has no customers, so a second
domain buys nothing yet and costs every one of those steps.

## Decision

Mac decided on 2026-09-30 to stop the move. Every service stays on
`oxagen.sh`:

- the app at `https://app.oxagen.sh`
- the API at `https://api.oxagen.sh`
- MCP at `https://mcp.oxagen.sh`
- the docs at `https://docs.oxagen.sh`

`APP_PROD_URL` stays `https://app.oxagen.sh`, and nothing resumes the
cutover. A third-party app (OAuth callbacks, webhooks) registers only
`oxagen.sh` URLs. `oxagen.app` stays registered to Mac and only redirects to
`https://app.oxagen.sh`.

## Consequences

- ADR-215 is superseded, including its amendment that says to revert the
  revert.
- The `.app` subdomains, their certificates and Caddy names, the app's
  canonical-host redirect, and the `oxagen.app` trusted origin come out in
  their own change (#4882). The `oxagen.app` zone keeps its mail and CAA
  records, so nobody can send mail as the domain.
- The `.app` URLs already registered with Slack and Linear do no harm and go
  at the next edit of each app.

## Alternatives

- **Finish the cutover.** Rejected: it needs the Google, GitHub, and
  Parameter Store steps above for a domain no customer uses.
- **Serve every service on both domains.** Rejected: two names per service
  doubles the certificates, Caddy names, and callback registrations for no
  reader.
