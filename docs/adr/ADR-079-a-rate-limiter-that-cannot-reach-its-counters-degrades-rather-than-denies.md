# ADR-079: A rate limiter that cannot reach its counters degrades rather than denies

- **Status:** Accepted
- **Date:** 2026-09-17
- **Owners:** platform
- **Related:** issue #3167 (Tacho ingest down in production), PR #3169 (the
  binding defect that made the counter store unreachable),
  `apps/api/src/middleware/distributed-rate-limit.ts`,
  `apps/api/src/middleware/rate-limit.ts`, `apps/api/src/app.ts`

## Context

`distributedRateLimiter` keeps its counters in Postgres so a ceiling is global
across instances. When the counter upsert throws, the limiter has to answer a
request it cannot count. Until now it took one of two policies, chosen per
mount by `failClosedOnStoreError`:

- **fail-open** (default) — pass the request through uncounted.
- **fail-closed** — answer `503 {"error":"rate_limit_unavailable"}`.

Four mounts were fail-closed, all of them pre-authentication ceilings against
credential stuffing: the per-IP and per-credential buckets on `/v1/tacho/*` and
on `/v1/telemetry/stella/*`.

On 2026-09-16 that policy took the evidence path off the air. The counter upsert
bound a JS `Date` into a raw `sql` template, which `postgres.js` cannot
serialize, so every upsert on every one of those four mounts threw — and had
been throwing since the limiter shipped. PR #3169 fixes the binding. What #3167
asks is the separate question: whether the 503 was the right answer to a store
that cannot be reached.

The cost of the deny was total. Every enrolled Tacho host got a 503 on every
ingest and every command poll, indefinitely, while its spool grew without
bound. Oxagen observed nothing that any governed agent did, which is the
product's evidence path, and the symptom pointed at Tacho rather than at the
limiter because the fail-open mounts on the same paths stayed quiet.

## Decision

`failClosedOnStoreError: boolean` is replaced by
`storeErrorPolicy: "fail-open" | "degrade-to-local"`. Neither value denies.
The four pre-authentication mounts take `"degrade-to-local"`, which hands the
request to the per-process limiter in `rate-limit.ts` — the same window, the
same ceiling, the same bucket key, counted in memory on this instance.

The ceiling under degradation is weaker than the one it replaces, and the
weakening should be stated rather than glossed: the limit stops being global and
becomes `max` per warm instance, so with N instances serving, a caller can spend
up to N times the ceiling. It is a bound, not the bound.

## Alternatives

**Keep fail-closed, add an alert.** An alert shortens an outage; it does not
stop one. More to the point, the deny protects less than it appears to. The
counter store is the same Postgres cluster the API authenticates against —
`withSystemDb` reaches the same database as `resolveApiKey`. A failure that
takes the counters away takes credential verification with it, so the credential
stuffing these mounts exist to bound is already answering 401 or 500 rather than
finding a valid key. The class of failure the deny actually catches is the one
that hits the counter statement alone, which is exactly what happened here, and
against that class the deny buys nothing and costs the whole ingress.

**Plain fail-open on these mounts.** This is the option with a real security
cost: an attacker who can break the counter store gets an ingress with no
ceiling at all, and "break one Postgres statement" is a lower bar than "break
authentication". Degrading keeps a ceiling in the failure mode where fail-open
removes it.

**Fail-closed with a bounded budget — deny only after some allowance.** That is
the in-memory limiter with extra steps, expressed as a policy nobody would be
able to reason about at 3am.

## Consequences

- A counter-store failure on a pre-authentication mount is now a logged
  degradation rather than an outage. `warnStoreError` names the policy in the
  message and in the structured field, once per window per route group.
- `rate_limit_unavailable` no longer exists as a response. No client ever
  depended on it beyond retrying, and the retry now succeeds.
- The per-instance ceiling is only as good as the instance count. Today the ALB
  fronts one app node, so the degraded ceiling equals the global one; that stops
  being true the moment a second node is attached, and it is not a reason to
  hold the change, only a reason to write it down.
- The degraded limiter's buckets live for the life of the process and are built
  on the first store failure, so a store outage that flaps does not reset the
  count each time.
- An alert on sustained 5xx from `/v1/tacho/*` is still worth having and is not
  part of this decision. It belongs to #3167's monitoring item, which needs the
  AWS account.
