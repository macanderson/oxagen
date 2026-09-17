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

`apps/api` had at the time been given a hop-count walk that reads the chain from the
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
   returns unconditionally** — including `null`.
4. Otherwise `null`.

There is no fourth branch, and there was one until #3205: a walk that counted
hops with `TRUSTED_PROXY_HOP_COUNT`. It is deleted rather than deprecated, and
the variable is gone from the schema, the registry and `.env.example`. A count
trusts ITSELF to be right while the caller controls the header's LENGTH, so a
count too high by k lets a caller pad k entries until the arithmetic lands on a
value it chose — enough to satisfy an `ip_ranges` allowlist it should fail — and
nothing readable from the request tells that apart from a correct deeper chain.
A fallback that silently produces an unvouched-for address is worse than no
address: it turns "this deployment cannot attribute callers" into "this
allowlist is enforced", which is a lie an operator acts on.

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

Before step 1 the identity walk over `TRUSTED_PROXY_CIDRS` decides, which is
where the deployment already was: the ALB's own address is still in the chain,
so a named proxy can vouch for the entry beside it. After step 1 Caddy has
rewritten `X-Forwarded-For` to the single client address and no proxy entry
remains to vouch with, so step 2 is what restores attribution — which is why the
window between them is the one place this rollout is briefly unattributed, and
why it fails closed rather than open.

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
- `TRUSTED_PROXY_HOP_COUNT` no longer exists (#3205) — see "The attribution
  order, stated once" for why counting hops cannot be made safe. Revisions of
  this ADR have described that variable as defaulting to 2, then to 1, then as a
  legacy fallback; all three are now history. Nothing reads it, and setting it
  does nothing.
- What makes the named proxies knowable in the first place is the Caddy trust
  list in `infra/tools/caddy/Caddyfile.alb`, and that list is the ALB's own
  subnets rather than `private_ranges`: on an internet-facing load balancer,
  trusting every RFC1918 range trusts the caller whenever the caller is itself
  RFC1918, and strict mode then walks past it into the prefix the caller wrote.
- An IP-scoped mandate now denies when the caller cannot be identified. That is
  a behaviour change and the intended one.
- **The signal an operator reads before setting that flag has to be true, and it
  was not.** The installer decided whether to reload Caddy with
  `cmp -s <render> /opt/oxagen/caddy/Caddyfile`, which asks whether the render
  differs from a file on disk when the question is whether it differs from what
  Caddy is RUNNING. A transient `caddy reload` failure aborted the remote script
  under `set -e` with the candidate already copied over that file and nothing to
  restore it; the candidate was correctly not promoted, but it stayed on disk.
  The retry then compared the same render against the file the failure had left,
  found them identical, printed "caddy config unchanged", skipped the reload,
  exited 0 — and the caller promoted the candidate and reported success. An
  operator acting on that success sets `TRUST_EDGE_CLIENT_IP_HEADER=true` over a
  Caddy still running the old config, which has no rule for
  `x-oxagen-client-ip` and forwards a caller-supplied copy unchanged. The
  `ip_ranges` bypass is open again, by a path that reports green at every step.
  The file is now kept honest instead — a `trap ... EXIT` restores the last
  accepted config, or removes the candidate where a first install has none to
  restore — so the existing comparison is correct again. Reading the running
  config instead (`caddy adapt` plus the admin API) is the stronger answer and
  was not taken: it compares adapted JSON, needs canonicalisation to do so
  safely, and changes meaning silently if a future Caddyfile disables the admin
  endpoint. The node bootstrap had the same shape from the other side — a
  validated config whose reload failed was left on the same file while the
  container kept the old one — and restores too.
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
- Only the edge header or a named proxy can name a caller for a bucket key,
  because those are the only two branches left anywhere. The reasoning that
  first excluded a hop count from bucket keys is the reasoning that later
  deleted it outright in #3205 — a count cannot defend itself on either path.
- The regression tests for this are the forged-header cases, one per surface, in
  `packages/oxagen/src/client-ip.test.ts`, `apps/api/src/__tests__/context.test.ts`,
  `apps/api/src/middleware/distributed-rate-limit.test.ts`,
  `apps/mcp/src/context.test.ts`, `packages/auth/src/auth-route.test.ts` and
  `apps/app_deprecated/src/lib/client-ip.test.ts`. Each one forges the header
  and asserts the forged value does not reach the decision. A case asserting
  only that the header is preferred when present passes against the
  implementation this amendment replaced.
