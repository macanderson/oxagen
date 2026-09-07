# ADR-046: A push to main gets its own CI concurrency group

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #2730 (CI stops checking and deploying main when merges come
  in fast), `.github/workflows/pipeline.yml` (`concurrency:`, `deploy-web`,
  `deploy-node`), `tools/scripts/check-main-concurrency.mjs`

## Context

GitHub keeps **one queued run per concurrency group**. While a run executes, a
second waits; a third evicts the second before it starts. `pipeline.yml` grouped
every run by ref:

```yaml
group: ci-${{ github.ref }}
```

so every push to `main` shared one group. The file's own comment had described
the eviction since 2026-08-27 and judged it harmless, on this reasoning: the
evicting commit contains the evicted one, so its run covers both.

That holds only while a run finishes before the next merge arrives.

On 2026-09-07 it did not. Merges landed every 10–20 minutes against a run taking
roughly 75, so each evicted the one queued behind it and the chain never
terminated. The last finished run on `main` was `40585e52` at 19:23 UTC. Eight
commits merged after it were never deployed, because `deploy-web` and
`deploy-node` run only after the check passes and no check ever concluded.

**Nothing went red.** An evicted run's conclusion is `cancelled`, which reads as
ordinary supersession. The failure mode is silence.

## Decision

**A push to `main` gets a concurrency group of its own, keyed by commit.**
Everything else keeps grouping by ref, where superseding a stale run is the
behaviour you want.

```yaml
group: >-
  ci-${{ github.ref }}${{
    github.event_name == 'push' && github.ref == 'refs/heads/main'
      && format('-{0}', github.sha) || ''
  }}
```

A run that cannot share a group cannot be evicted, which is what makes "every
commit on `main` gets a finished check" true rather than usually true — and what
makes a skipped deploy impossible rather than unlikely.

`cancel-in-progress` is unchanged: still `github.event_name == 'pull_request'`,
so a new push to a PR still cancels the run it supersedes.

## What it costs

**Concurrent runners during a burst.** Ten merges in an hour now start ten runs
instead of evicting eight of them. That is the trade, and it is accepted because
the thing being bought is not speed but knowing: the alternative was a tree that
silently stopped deploying and reported nothing.

It is bounded by merge rate rather than unbounded, and a burst is exactly when
having every commit checked matters most — a bisect over run history now finds
one run per commit instead of gaps that are not failures.

## Why not the alternatives

**A merge queue** solves it properly by serialising merges, and is the better
long-term answer. It also changes how every contributor merges, needs branch
protection reconfigured across the repository, and could not have been shipped
as a response to an active incident. This does not preclude it.

**Splitting deploys into their own workflow** was the issue's other suggestion.
It decouples deploy from check eviction, but leaves the check itself still
evicted — so `main` would deploy while remaining unverified, which trades a
visible gap for a quieter one.

## Consequences

- `tools/scripts/check-main-concurrency.mjs` holds the property, wired into
  `check:contracts`. A future edit simplifying the expression back to
  `ci-${{ github.ref }}` restores the outage and would look like a tidy-up in
  review; the guard fails it, citing the incident.
- Its unit tests carry the witness: the shared group is asserted to fail, so the
  test would have caught the configuration that shipped.
- Not customer-facing. This is CI and ops; no user-facing documentation changes.
- Still open in #2730: an automatic check that notices when `main` has gone too
  long without a finished passing run. This ADR removes the cause; that would
  catch a future cause nobody predicted, and `stella`'s
  `scripts/check-main-verified.sh` is the working example to port.
