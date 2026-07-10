---
description: Stability hardening — failure-mode audit, timeouts, retries, backpressure, graceful degradation, fault-injection tests
argument-hint: <service/module> [critical dependencies]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

Target: $ARGUMENTS

Assume every dependency will be slow, flaky, or down — the question is what
happens when it is.

AUDIT (produce a failure-mode table before editing)
For every outbound call and entry point: Timeout set? (missing = P0). Retry
policy — idempotent-safe, bounded, backoff + jitter? What happens when this
dependency is down: raw error, hang, cascade, or graceful degradation? Errors
swallowed silently anywhere? (empty catch = P0). Unbounded anything: queues,
buffers, result sets, concurrency, request body sizes. Shutdown behavior:
in-flight requests drained, connections closed?

FIX PRIORITY
1. Missing timeouts on all network IO (client and server side).
2. Swallowed errors → propagate with context or handle explicitly; every
   failure observable (structured log + metric).
3. Unbounded resources → limits, backpressure, explicit rejection behavior.
4. Retries → idempotency keys where needed, exponential backoff + jitter,
   retry budgets; never blindly retry non-idempotent writes.
5. Circuit breaking / load shedding on the flakiest dependencies.
6. Graceful degradation: define per dependency what the user sees when it's
   down (cached data, reduced feature, clear error) — implement it.

RULES
Every fix ships with a test simulating the failure (fault injection, fake
slow/erroring dependency). No happy-path behavior change without a stated
reason. Tests green after every commit.

DELIVERABLE
The failure-mode table, before → after per dependency; P0s fixed, each with
its failure-simulation test; remaining weak points ranked by (likelihood ×
blast radius) with proposed fixes and effort. Reflect per the
reflective-memory skill.
