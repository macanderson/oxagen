# ADR-083: One client-IP derivation, and the edge rewrites the header it is not allowed to trust

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform
- **Related:** PR #3183 review finding (P1), ADR-082,
  `packages/oxagen/src/client-ip.ts`, `infra/tools/caddy/Caddyfile.alb`,
  `packages/oxagen/src/iam/conditions.ts`

## Context

Three surfaces each grew their own client-IP extraction, and all three took the
leftmost `x-forwarded-for` entry:

| surface | reader |
|---|---|
| `apps/app` | chat stream route, and the sign-in audit record |
| `apps/mcp` | `extractClientIp` in `context.ts` |
| `apps/api` | `extractClientIp` in `lib/context.ts` |

Each proxy APPENDS the address it received the request from, and neither the
ALB nor Caddy strips an inbound copy. The leftmost entry that reaches an
upstream is therefore whatever the caller typed into the header. Measured on a
local Caddy running the committed `Caddyfile.alb`: a request carrying
`X-Forwarded-For: 203.0.113.9, 198.51.100.7` arrived at the upstream as
`203.0.113.9, 198.51.100.7, <caddy peer>`.

That value feeds the IAM `ip_ranges` / `ip_allow` conditions, which **allow** on
a CIDR match. So a caller could prefix an allowlisted address and satisfy an
IP-scoped mandate — a governance bypass, in the control plane whose product is
deciding what an agent may do. Two of the three readers carried a comment
calling the headers spoofable and used them anyway, which is the shape of the
bug rather than a mitigation of it.

`apps/api` had already been given a hop-count walk that reads the chain from the
right. That is the correct arithmetic and it did not help the other two, because
it lived in `apps/api`.

## Decision

**One derivation.** `extractTrustedClientIp` in `@oxagen/oxagen/client-ip` is
the only client-IP reader in the repo. It trusts exactly one header per
deployment shape — `x-oxagen-client-ip` from Caddy on AWS,
`x-vercel-forwarded-for` on Vercel, each SET by that edge rather than appended
to — falls back to the hop-count walk of `x-forwarded-for`, never reads
`x-real-ip`, and returns `null` when nothing trustworthy named the caller.
`null` denies an IP condition, so the failure is visible rather than permissive.

**And the edge rewrites the header.** Caddy sets `X-Forwarded-For` to
`{client_ip}` on every application upstream and deletes `X-Real-Ip`, so no
caller-written copy of either exists inside the perimeter.

Both, not either.

## Alternatives

**Only teach the consumers.** Narrower and it matches what the rate limiter
already did. It leaves a caller-controlled header one `grep` away from the next
consumer who reaches for `x-forwarded-for` because that is what one reaches for
— which is exactly how three surfaces acquired the same bug independently.

**Only rewrite the header at the edge.** Simple, and it makes every consumer
safe without touching application code. It also puts the entire control in a
file that deploys through a different pipeline from the code: the Caddy config
is uploaded by `infra/tools/install-node-scripts.sh` by hand, so there is a real
window in which the application has shipped and the proxy has not. A mandate
decision that is only safe when an unrelated deploy has happened is not safe.

**Rewriting the chain loses the forwarded hops.** It does. Nothing in this repo
walks them — all four readers want a single client address — and the ALB access
logs keep the full chain for anything that later does.

## Consequences

- Reaching for `request.headers.get("x-forwarded-for")` is now the anomaly, and
  there is one obvious function to reach for instead.
- `x-real-ip` is gone as an input. Nothing in either deployment shape set it, so
  nothing legitimate is lost.
- `TRUSTED_PROXY_HOP_COUNT` defaults to 2, not 1: the deployed shape has two
  appending proxies, the ALB and Caddy. At 1 the walk returns Caddy's peer — a
  load balancer's private address — and an allowlist of real client CIDRs
  matches nothing, so every IP-scoped mandate silently denies. With the Caddy
  rewrite deployed the count stops deciding anything; it decides everything in
  the deploy-skew window.
- An IP-scoped mandate now denies when the caller cannot be identified. That is
  a behaviour change and the intended one.
