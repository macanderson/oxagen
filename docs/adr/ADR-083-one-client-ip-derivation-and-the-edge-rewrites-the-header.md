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
the only client-IP reader in the repo. It never reads `x-real-ip`, and it
returns `null` when nothing trustworthy named the caller. `null` denies an IP
condition, so the failure is visible rather than permissive.

### The attribution order, stated once

This ADR has now been corrected three times for prose that described a version
of this behaviour that no longer existed, each time found by review. So it is
written down here once, against the branches of `extractTrustedClientIp`, and
every other passage in this document points here rather than restating it. If
this section and the function disagree, the function is right and this section
is the bug.

1. **On Vercel** — `x-vercel-forwarded-for`, which Vercel replaces at its own
   boundary. Nothing else is consulted.
2. **`x-oxagen-client-ip`**, but only while `TRUST_EDGE_CLIENT_IP_HEADER` is
   `true`. While the flag is false the header is not read at all — not
   read-and-discarded.
3. **The identity walk** over `TRUSTED_PROXY_CIDRS`, when that list is
   non-empty. It walks `x-forwarded-for` from the right while each entry is a
   named proxy, stops at the first that is not, and returns that entry only if
   a trusted proxy stood to its right. **Once the list is non-empty this branch
   returns unconditionally** — including `null`. It does NOT fall through to
   step 4.
4. **The hop-count walk** over `TRUSTED_PROXY_HOP_COUNT`, reached only when
   `TRUSTED_PROXY_CIDRS` is empty. A chain SHORTER than the declared depth is
   refused outright, never clamped to its leftmost entry. The default is **1**.
5. Otherwise `null`.

Two consequences of that order are load-bearing and are the ones the corrections
kept getting wrong:

- **There is no shared fallback bucket.** When nothing attributes the caller,
  `trustedClientIpBucketKey` (`apps/api/src/middleware/distributed-rate-limit.ts`)
  returns `null` and `distributedRateLimiter` SKIPS — it does not count and it
  does not deny. An earlier design pooled such requests into one
  `ip:unverified` bucket; that is gone, because on a mount running before any
  credential exists a bucket every caller shares is one caller's power to deny
  the ingress to all the others. The per-credential ceiling beside it is
  unaffected either way.
- **Setting `TRUSTED_PROXY_CIDRS` can turn attribution OFF.** Because step 3
  decides alone, naming proxies in a deployment whose edge has rewritten
  `x-forwarded-for` to a single client address leaves no proxy entry to vouch
  for anything, so the walk returns `null`: every `ip_ranges` mandate denies and
  the pre-authentication ceilings skip. The variable belongs to the pre-rewrite
  shape.

**And the edge rewrites the header.** Caddy sets `X-Forwarded-For` to
`{client_ip}` on every application upstream and deletes `X-Real-Ip`, so no
caller-written copy of either exists inside the perimeter.

Both, not either.

**And the new header is off by default until the edge that writes it exists.**
`TRUST_EDGE_CLIENT_IP_HEADER` defaults to `false`, and while it is false
`x-oxagen-client-ip` is not read at all. This was added after a second review
finding on PR #3183, described below.

## Amendment, same day: the header this ADR introduced was itself spoofable

The first version of this decision said the application had to be safe before
the proxy deploy, and then shipped a reader that trusted `x-oxagen-client-ip`
the moment it was present. Those are not compatible, and the gap between them
was worse than the defect the ADR was written to close.

The reasoning that was wrong, stated as it was stated: *config and code can land
in either order with no regression window, because when the header is absent the
code falls back to the hop-count walk.* That covers **absent**. It does not
cover **present and forged**, and those are different states. The previous
Caddyfile has no rule for `x-oxagen-client-ip` at all, so it forwards a
caller-supplied copy straight through to the upstream — and the trusted-header
branch runs before the fallback ever would.

A forged `x-oxagen-client-ip` is a strictly worse bypass than the leftmost
`x-forwarded-for` read this ADR replaced. The old bug at least required the
attacker to know the proxy topology and construct a chain. The new one is
trusted unconditionally, by name, with no chain to get right.

Two shapes of fix were available. **Deploy Caddy first** is an ordering
instruction to a human: nothing enforces it, nothing detects the other order,
and it fails silently. That is the same class of guarantee whose loss #3186
exists because of. **Gate the header behind a flag that is off by default** puts
the safe state on the default path and makes the unsafe state require a
deliberate act. We took the flag.

The rollout is therefore two steps in a fixed order, with the code safe at every
point in between and after:

1. Upload and reload the Caddy config that SETS `X-Oxagen-Client-Ip`.
2. Set `TRUST_EDGE_CLIENT_IP_HEADER=true`.

Between the two, and before either, the hop-count walk decides, which is where
the deployment already was: Caddy rewrites `X-Forwarded-For` to a single entry
and a hop count of 1 reads it. If the flag is never set, nothing breaks.

`TRUSTED_PROXY_CIDRS` does NOT belong in that window — see "The attribution
order, stated once" above for why, and set it only against the pre-rewrite
shape, where the ALB's own address is still in the chain to vouch for the
client.

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
This paragraph was already in the first version of this ADR, and the first
version shipped the reader it argues against.

**Deploy the Caddy config before the application, as a documented order.** No
code, no flag, and it is what the two pipelines would do if anyone remembered.
It is a promise rather than a mechanism: nothing enforces the order, nothing
notices the other order, and the failure is silent and exploitable for as long
as it lasts. Rejected for the reason in the amendment above.

**Rewriting the chain loses the forwarded hops.** It does. Nothing in this repo
walks them — all four readers want a single client address — and the ALB access
logs keep the full chain for anything that later does.

## Consequences

- Reaching for `request.headers.get("x-forwarded-for")` is now the anomaly, and
  there is one obvious function to reach for instead.
- `x-real-ip` is gone as an input. Nothing in either deployment shape set it, so
  nothing legitimate is lost.
- `TRUSTED_PROXY_HOP_COUNT` defaults to **1**, and a short chain is refused
  rather than clamped — both stated in "The attribution order, stated once".
  An earlier revision of this ADR said the default was 2, on the reasoning that
  the ALB and Caddy both append. That was measured false against `caddy:2`,
  which REPLACES the chain with its own peer rather than appending, and this
  deployment's Caddyfile sets a single entry, so the chain reaching the app is
  one deep either way. Setting 2 on the strength of the old text yields no
  address at all — a count of 2 against a one-entry chain is a short chain, and
  a short chain is refused — and every IP-scoped mandate then denies.
- The hop count is the legacy form and governs only the IAM `ip_ranges`
  allowlist. It does not enable the pre-authentication IP ceilings; naming your
  proxies in `TRUSTED_PROXY_CIDRS` does, and the Caddy trust list that makes
  those proxies knowable is `infra/tools/caddy/Caddyfile.alb`.
- An IP-scoped mandate now denies when the caller cannot be identified. That is
  a behaviour change and the intended one.
- `TRUST_EDGE_CLIENT_IP_HEADER` is a flag the operator must set, and until it is
  set the edge header this ADR introduced does nothing. That is the cost of the
  mechanical version of the invariant, and it is cheaper than a header nobody
  can tell is forged.
- On the pre-authentication rate-limit mounts, an ungated edge header means a
  forged one is not read, so it cannot mint a bucket per forged address. Nor
  does it collapse those callers into a shared bucket: an earlier revision of
  this bullet described an `ip:unverified` fallback that no longer exists. When
  nothing attributes the caller the ceiling SKIPS — see "The attribution order,
  stated once". Attribution is still available with the flag off, through
  `TRUSTED_PROXY_CIDRS`, so "ungated" does not mean "unenforced"; it means the
  edge header is one of the two ways in rather than the only one.
- Those mounts pass `trustedProxyHops: 0`, so a hop count can never name a
  caller for a bucket key — only the edge header or a named proxy can. A count
  cannot defend itself here: one that is too high lets a caller pad
  `x-forwarded-for` until the arithmetic lands on a value it chose, which on a
  ceiling means a fresh bucket per request. The count remains for the IAM
  allowlist, which is judged on a different question.
- The regression tests for this are the forged-header cases, one per surface, in
  `packages/oxagen/src/client-ip.test.ts`, `apps/api/src/__tests__/context.test.ts`,
  `apps/api/src/middleware/distributed-rate-limit.test.ts`,
  `apps/mcp/src/context.test.ts`, `packages/auth/src/auth-route.test.ts` and
  `apps/app_deprecated/src/lib/client-ip.test.ts`. Each one forges the header
  and asserts the forged value does not reach the decision. A case asserting
  only that the header is preferred when present passes against the
  implementation this amendment replaced.
