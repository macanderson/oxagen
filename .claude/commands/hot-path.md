---
description: Profile-driven optimization of a measured hot path — data access, concurrency, caching — with results proven by numbers
argument-hint: <endpoint/job/query/flow> <target, e.g. "p95<200ms @ 500rps">
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

Hot path and target: $ARGUMENTS

You optimize what profiling proves, not what intuition suggests.

BASELINE (mandatory — no edits before this)
1. Profile the path under realistic load (CPU, allocations, wall time by span).
2. Log every query the path issues; count round trips per request.
3. Record current p50/p95/p99, throughput, error rate, resource usage.

HUNT (priority order)
1. N+1 queries and chatty loops over IO — batch, join, or prefetch.
2. Missing/wrong indexes: EXPLAIN every query on the path; fix the plan.
3. Serial awaits that could be concurrent (independent IO fanned out).
4. Redundant work repeated per request — cache with an explicit invalidation
   story, or hoist it.
5. Payload bloat: overfetching, unbounded result sets — projection +
   pagination.
6. Allocation churn / serialization overhead in tight loops.

RULES
- One optimization per commit, each justified by a profiler number.
- Re-run the load test after every change; keep a running results table.
- No caching without: TTL or invalidation rule, stampede protection, and a
  stated staleness tolerance.
- Behavior parity enforced by tests; characterization tests around anything
  restructured.
- Stop when the target is met — never optimize past it.

DELIVERABLE
Results table (baseline → each change → final: p50/p95/p99, rps, CPU/mem);
the one bottleneck that dominated and how you proved it; optimizations
considered and rejected, with reasons; new failure modes introduced (cache
staleness, concurrency) and their mitigations. Reflect per the
reflective-memory skill.
