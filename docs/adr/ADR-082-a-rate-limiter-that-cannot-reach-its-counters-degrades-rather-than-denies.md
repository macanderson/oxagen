# ADR-082: A rate limiter that cannot reach its counters degrades rather than denies

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
- `max` per warm instance is the bound in a flapping window too, not only in a
  clean outage. Every ALLOWED request is counted into the local counter,
  including the ones the Postgres upsert handled, and the shadow count is
  ENFORCED on the healthy path rather than merely recorded. Recording alone
  closes one ordering and not the other: healthy-then-failed is bounded because
  the local counter starts from where Postgres got to, but failed-then-healthy
  is not, because a recovered Postgres counter starts this window at 1 and would
  permit a second full `max`. Both orderings had to be closed for the bound in
  this ADR to be true.
- **Counting on the healthy path has a memory cost, and it is adversarial.**
  Mirroring every allowed request means one map entry per bucket key per window
  on the four pre-authentication mounts — and on those mounts an unauthenticated
  caller chooses its own keys, one per `Authorization` value. The first version
  of this bounded the map by sweeping entries whose window had expired, which
  bounds it across windows and not at all inside one: two source IPs could stay
  under the 6,000-per-IP ceiling while minting more than 10,000 credential
  buckets in a minute, with the sweep scanning the whole map on every request
  and deleting nothing. `createFixedWindowCounter` now holds a hard maximum and
  evicts the oldest entry, the pattern `cacheLocalDeny` already used.
- **Two counters bounding one window must read one clock.** The Postgres
  `window_start` is derived from a timestamp captured before the upsert is
  awaited. The shadow counter originally read `Date.now()` again afterwards, so
  a request whose await crossed a window boundary was recorded in Postgres under
  one window and locally under the next — one request in two windows, which is
  the same divergence as one allowance spent twice and arrives from the same
  place. It also cached the resulting denial against a reset time that had
  already passed, which is not a cached denial at all: the next request drops it
  and goes back to the store. `hit()` now takes the captured timestamp, and
  `cacheLocalDeny` refuses a reset time in the past — against the clock it reads
  itself rather than the caller's captured one, for the reason two bullets down.
- **The shadow hit is taken at admission, not after the store call returns.**
  `createFixedWindowCounter` retains exactly one previous window, deliberately,
  so per-key state is a constant rather than a history a pre-authentication
  caller can grow. A shadow hit taken after the await inherits the store's
  latency, and a store call outliving two window rolls comes back asking about a
  window the counter has dropped. The counter answers the only honest thing it
  can — that it has no record, reported as `count: 1` — and it answers that
  INDEPENDENTLY to every caller in the same position, so a cohort of any size
  parked behind one slow call all read 1 and all pass a ceiling of `max`. Both
  halves of "slow enough" are facts of this tree rather than a hypothesis: the
  limiters use 60-second windows, and the pool in
  `packages/database/src/client.ts` is built with `max` and `prepare: false` and
  nothing else, so no statement timeout bounds a call at 120 seconds. Counting
  at admission bounds the cohort whether or not the store call ever returns.
  The alternative — retaining a window until its outstanding calls drain — is
  correct and reintroduces precisely the unbounded per-key state the
  one-previous-window rule exists to prevent, on the mounts where the caller is
  not yet authenticated. Counting at admission also makes out-of-order arrival a
  non-question for this call site rather than a handled case: `now` is captured
  and the hit taken in the same synchronous run, so for a given key the hits
  arrive in clock order however the store behaves. The counter's out-of-order
  paths stay, because it is exported and `rateLimiter` uses it too.
- **A completion may not write state a later window has already superseded.**
  This is the shadow-hit rule from the other end, and the deny cache did not
  hold it. `cacheLocalDeny` judged the reset time it was handed against the
  caller's captured `now`, and every one of its three call sites is past the
  store await — so a request admitted in one window and completing two windows
  later offered a reset that had closed while it waited, found it still in the
  future against its own stale clock, and wrote it over whatever the current
  window had cached. That moves the cache's expiry BACKWARDS past the real
  clock: the next request reads an entry that has already expired, drops it, and
  goes back to the database. The cache is defeated for exactly as long as the
  store is slow, which is when it is the only thing keeping load off a failing
  store — the mode defeating its own purpose, one layer down from where that was
  already fixed. `cacheLocalDeny` now reads `Date.now()` itself, which closes it
  for all three call sites at once.

  The review that found it also asked for the later of the two expiries to be
  kept. That is unreachable once the clock is read here, and the argument is
  short enough to keep: both values are the reset of the window containing some
  captured `now`, and both captures precede the current clock; for the incoming
  one to survive the guard the clock must be inside its window, and for the
  cached one to still be live the clock must be inside that window too. One
  clock is in one fixed window, so the two are equal. A strictly smaller live
  incoming value needs the clock to step backwards, and a backwards step lands
  on the guard rather than past it. An unreachable comparison is not a second
  guard; it is a line no test can pin, and this file has already paid for one of
  those.
- **The rate-limit headers report the stricter of the two counts.** When the
  store recovers inside a window the shadow already owns, the shadow is the
  operative ceiling and the Postgres count is the smaller, irrelevant number. An
  allowed response that reports the Postgres remainder tells a client it has
  room and then rejects its next request — worse than no header, because the
  header is what the client paces against.
- **Three of the findings on this path were about a crossing, not a state.**
  Healthy was tested and fully-degraded was tested; store failure mid-request, a
  window rolling in flight, a store recovering mid-window and a cached deny
  outliving its window were not. They are now enumerated in a comment above the
  middleware body. A test that drives a burst entirely inside one window passes
  against every one of those defects, because the boundary is the defect; what
  discriminates is a burst that straddles it with the clock frozen either side.
- **CI went 14/14 green over that defect, and over the quadratic scan under it.**
  A correctness fix introduced a resource-exhaustion bug and the full gate —
  lint, typecheck, unit, coverage, e2e, RLS, RDS — had nothing to say about it,
  because none of those ask what a structure costs under a caller that is trying
  to make it expensive. Anyone changing what this limiter counts on the healthy
  path should assume the suite will not catch the cost, and should write the
  bound as a test that floods distinct keys inside one frozen window and asserts
  on the size of the map. A test that lets the window roll passes against the
  broken version.
- The degraded limiter's buckets live for the life of the process and are built
  on the first store failure, so a store outage that flaps does not reset the
  count each time.
- An alert on sustained 5xx from `/v1/tacho/*` is still worth having and is not
  part of this decision. It belongs to #3167's monitoring item, which needs the
  AWS account.
