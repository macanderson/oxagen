---
description: Scale readiness — find what breaks first at Nx load and fix in breaks-first order (statelessness, contention, async, quotas)
argument-hint: <system/subsystem> <current scale> <target, e.g. 10x>
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, MultiEdit
---

System, current scale, and target: $ARGUMENTS

Prepare this system for the target load without re-architecture panic.

AUDIT (rank by "what breaks first at target scale")
1. State in process memory: sessions, caches as source of truth, local file
   writes, in-memory job state — anything preventing >1 replica or a clean
   replica-death.
2. Contention: table hot spots, row locks, serialized critical sections,
   single-consumer queues, global mutexes.
3. Synchronous request-path work that could be async: emails, webhooks,
   analytics, fan-out — queue it (outbox pattern where consistency matters).
4. Data growth: unbounded tables without archival/partitioning; queries whose
   cost grows with total data rather than result size.
5. Fan-out multipliers: one request → M internal calls → M×K queries. Cap or
   batch the multiplication.
6. Shared fate: one tenant able to consume all capacity — per-tenant
   limits/quotas/isolation where it matters.

EXECUTION RULES
- Fix in breaks-first order; after each fix state the new estimated ceiling
  and what breaks next.
- Statelessness first — it unlocks horizontal scaling and cheapens everything
  else.
- Every async migration preserves delivery semantics: state at-least-once or
  at-most-once per operation and make consumers match (idempotent handlers
  for at-least-once).
- Tests green after every commit; load/soak tests for each fixed bottleneck
  where feasible.

DELIVERABLE
Ranked breaks-first list with before/after ceilings; changes in order, each
with the headroom it bought; the next 3 bottlenecks beyond this pass; every
consistency-for-scale trade stated explicitly. Reflect per the
reflective-memory skill.
