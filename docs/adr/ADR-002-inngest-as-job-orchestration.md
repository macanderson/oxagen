# ADR-002 — Inngest as job orchestration

**Date:** 2026-05-27
**Status:** Accepted
**Epic:** Foundations

## Context

The runner needs durable execution for workflow steps, retries,
event-driven triggers, and scheduled jobs (nightly usage rollup, Stripe
sync, subagent fanout). Agent capabilities marked `mode: async`
inherently need a queue.

## Decision

Use **Inngest** for durable jobs and event-driven orchestration.
`apps/runner` hosts the canonical Inngest serve endpoint; `apps/api`
and `apps/app` emit events via the Inngest client.

## Alternatives considered

- **Temporal.** More powerful (signals, queries, child workflows) but
  heavier ops surface, separate worker pool, separate UI. Overkill for
  the foundation; revisit if subagent fanout patterns outgrow Inngest.
- **Postgres-backed queue (`pg-boss`, custom).** No external dep but
  reinvents retries, scheduling, and observability. Loses the
  TypeScript-native event surface.
- **BullMQ + Redis.** Solid but JS-only and another infra component.

## Consequences

- Inngest events typed in `apps/runner/src/inngest.ts`.
- Cron jobs (e.g. nightly `billing.rollup-usage`) declared as Inngest
  functions with `cron:` triggers.
- Subagent fanout uses `step.invoke()` for child capabilities.
- Step-level state remains in Postgres (`execution.execution_steps`);
  Inngest holds in-flight orchestration.
- Free tier covers early development; paid tier kicks in at scale.
