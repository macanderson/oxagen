# `@oxagen/run-ledger`

The durable **evidence ledger** for governed agent runs. It is the only writer
of the `agent.agent_runs*` tables, and it executes nothing.

[ADR-043](../../docs/adr/ADR-043-runtime-excision.md) removed Oxagen's agent
runtime. The durable worker that claimed runs, leased them, checkpointed engine
state and reclaimed expired attempts is gone, along with the two tables that
existed only to support it (`agent_run_checkpoints`,
`agent_run_attempt_leases`). What survives is the chain of custody an external
engine's drain submits and Oxagen stamps
([`docs/specs/run-evidence-ingress/spec.md`](../../docs/specs/run-evidence-ingress/spec.md)):

```
run          trusted RunSpecV2 identity — principals, agent version,
 │           authorization snapshot, repository + retention bindings
 └─ attempt  immutable, `arat_…`, pinned engine name / version / build digest
     └─ events    append-only, dual run_seq + attempt_seq, digest-chained
         └─ seal          one per attempt, for EVERY terminal outcome
             └─ finalization grant + durable obligation   one shot each
```

## Boundary

- **Owns:**
  - Every write to the `agent.agent_runs*` tables: run admission, attempts,
    event appends, seals, terminal outcomes, and run control (cancel and
    ingress pause).
  - The trusted admission contract, `RunSpecV2`, and its canonical JSON.
  - The closed event vocabulary and the event and stream digest contract.
  - Frame bodies and the seal's replay evidence, including the rollup and
    completeness gaps (ADR-058).
  - The evidence store: encrypted frame bodies, archive segments, and export
    bundles written through `@oxagen/storage` under tenant-first keys.
  - Reassembly of a recorded model stream into the message it was, and the
    one-line step summary over it.
- **Does not own:**
  - Running an agent. Nothing here executes (ADR-043).
  - The Tacho wire format and its digest patterns:
    [`@oxagen/tacho`](../tacho/README.md).
  - The capability handlers that ingest frames and read runs:
    [`@oxagen/handlers`](../handlers/README.md).
  - The durable jobs that enrich, summarize, compact, and export runs:
    [`@oxagen/inngest-functions`](../inngest-functions/README.md).
  - The database schema for the run tables:
    [`@oxagen/database`](../database/README.md).
- **Depends on:**
  - `@oxagen/database`: the run tables, `withTenantDb`, and the `Tx` type.
  - `@oxagen/tacho`: the event envelope vocabulary, digest patterns, and
    archive content types.
  - `@oxagen/storage`: the blob store behind the evidence store.
  - `@oxagen/crypto`: envelope encryption for stored frame bodies.
- **Used by:** `apps/api`, `apps/app`, `apps/app_deprecated`,
  `@oxagen/agent`, `@oxagen/billing`, `@oxagen/handlers`, and
  `@oxagen/inngest-functions`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `createPostgresRunStore` | export | `packages/run-ledger/src/run-store.ts` | `packages/handlers/src/run.frames.ingest.ts`, `packages/handlers/src/lib/run-read.ts`, `packages/agent/src/runtime/assistant-run.ts`, `packages/inngest-functions/src/lib/run-record.ts` |
| `RunBodyStore` / `RunArchiveStore` | port | `packages/run-ledger/src/frame-body.ts` | Implemented by `evidenceStore()` in `src/evidence-store.ts`, passed as `bodies` and `archive` |
| `RunSecurityEventSink` | port | `packages/run-ledger/src/run-store.ts` | No caller passes one. Every store falls back to a sink that writes to `console.error`. |
| `RunStoreOptions.authorizeAppend` | port | `packages/run-ledger/src/run-store.ts` | `packages/handlers/src/run.frames.ingest.ts`. It runs under the append's run lock. |
| `evidenceStore` / `deferredEvidenceBodies` / `deferredEvidenceArchive` | adapter | `packages/run-ledger/src/evidence-store.ts` | `packages/handlers/src/run.frames.ingest.ts`, `packages/handlers/src/lib/run-read.ts`, `packages/inngest-functions/src/functions/run.enrich.ts` |
| `lockRunForControl` / `cancelRunInTransaction` / `setRunIngressPaused` | export | `packages/run-ledger/src/run-control.ts` | `packages/handlers/src/tacho.command.dispatch.ts`, `packages/handlers/src/run.token.issue.ts` |
| `listIdleLedgerAttempts` / `ledgerIdleCutoff` | export | `packages/run-ledger/src/idle-attempts.ts` | `packages/inngest-functions/src/functions/run.ledger-idle-close.ts` |

## Entry points

- `.` (`src/index.ts`): the run store, run control, frames, frame bodies, the
  event payload registry, finalization grants, `RunSpecV2`, errors, and
  reassembly.
- `./run-spec-v2` (`src/run-spec-v2.ts`): the admission contract alone.
- `./run-errors` (`src/run-errors.ts`): the typed errors alone, with no
  dependencies.
- `./evidence-store` (`src/evidence-store.ts`): the blob-backed evidence
  store. The barrel does not re-export it.

## Modules

| File | What it owns |
|---|---|
| `run-spec-v2.ts` | The trusted admission contract. Built only by server code, never from a request body: surfaces parse caller input with `parseCallerRunInfluence` and hand it to `buildTrustedRunSpecV2` alongside separately-resolved trusted sections. Also RFC 8785 canonical JSON and the run-row ↔ spec identity comparison. |
| `event-payload-registry.ts` | The closed event vocabulary (nine evidence stages), the inline-payload allow list and byte cap, the forbidden raw-content roots, and the event / stream digest contract a finalizer must reproduce byte for byte. |
| `run-store.ts` | The ledger itself: run admission, immutable attempts, appends, seals, terminal outcome, and the read side. Every SQL builder and row mapper is a pure exported function. |
| `finalization-grant.ts` | The one-shot, non-expiring finalization grant and its durable obligation, minted in the same transaction as every seal. |
| `run-errors.ts` | Typed, dependency-free errors with stable `code` discriminants plus structural guards. |
| `surface.ts` | Which platform surface admitted a run. |
| `run-control.ts` | The run lock shared with appends and seals, cancel inside a transaction, and pausing evidence ingress. |
| `idle-attempts.ts` | The cross-tenant scan for open attempts with no event for twelve hours, which the control plane seals `abandoned` (ADR-172). |
| `frame-body.ts` | Frame body preparation under the run's retention policy, the body and archive store ports, and the seal's rollup, completeness gaps, and replay grade (ADR-058). |
| `run-frames.ts` | One frame shape for a run from either store, and the pure transcript reads over it. |
| `content-blocks.ts` | Reassembly of a recorded model stream into the message it was, and its encoded form. |
| `assembly-write.ts` | Writing a frame's reassembly beside its wire at ingest. |
| `step-summary.ts` | The one line a step card leads with, and the figures beside it. |
| `evidence-store.ts` | Encrypted frame bodies, archive segments, and export bundles in blob storage, keyed by tenant first. |

## Invariants

- **The log is the pointer.** An attempt's position in its own stream
  (`event_count`, last sequences, final event digest, running stream digest) is
  *derived* from the durable event rows by `foldAttemptEventState`, never read
  off a mutable column. A pointer cannot disagree with the log it summarizes if
  it does not exist. Serialization comes from the run row's `FOR UPDATE` lock,
  which the `next_run_seq` allocator needs anyway.
- **The seal is the fence.** There is no lease token and no epoch. An append or
  a second seal against a sealed attempt raises `AttemptNotWritableError`.
- **Dense sequences, or nothing.** `attempt_seq` is producer-assigned and dense
  from 1. A gap inside a batch, or between a batch and the durable log, is
  refused (`RunEventSequenceGapError`) rather than repaired.
- **Same sequence, same digest, or a security event.** A re-sent prefix is
  idempotent only when every digest matches. The same `(attempt_id,
  attempt_seq)` with a different digest raises `RunEventIntegrityError` and is
  reported to the `RunSecurityEventSink` *after* the transaction rolls back.
  No caller injects a sink today, so the report goes to the default sink,
  which writes to `console.error`. The insert deliberately carries no
  `ON CONFLICT` clause.
- **A zero-event attempt seals honestly.** Null final-event digest, the
  canonical empty-stream digest, no synthesized terminal event.
- **A silent attempt is sealed for its producer, and the seal is final.**
  `run.ledger-idle-close` in `@oxagen/inngest-functions` seals an open attempt
  with no event for twelve hours as `abandoned` (reason `idle_timeout`), which
  records `unobserved_tail` and fails the run. The seal passes
  `expectedAttemptSeq`, so a producer that appended since the scan keeps its
  attempt (`AttemptAdvancedError`). A producer that returns after the seal is
  refused like any append past a seal (ADR-172).
- **A caller's mistake is typed as the caller's.** A malformed event raises an
  error `isRunEventInputError` recognizes, and a run that cannot take an
  attempt raises `RunNotWritableError`. Surfaces answer both as client errors.
  `RunStoreStateError` is kept for stored state that is missing or
  inconsistent, which is a server fault.
- **Seal, grant and obligation are one transaction.** A seal without its grant
  would be evidence nobody may finalize; a grant without its obligation would be
  authority nobody is scheduled to use. A duplicate seal returns the *same*
  handle — above all the same `submission_id`.
- **Tenant-scoped, with two exceptions.** Every store method except
  `compactSealedAttempts` runs under `withTenantDb`, so RLS from the caller's
  ambient scope is the tenant filter. `compactSealedAttempts` runs under
  `withSystemDb` because it compacts sealed attempts across every tenant. The
  `evidence.frame-compaction` job in `@oxagen/inngest-functions` calls it.
  `listIdleLedgerAttempts` also reads under `withSystemDb`, and the idle close
  then seals each attempt in its own tenant's scope. The other cross-tenant
  paths left with the worker pool and the lease sweeper.

## Tests

```bash
pnpm --filter @oxagen/run-ledger test:unit src/run-store.test.ts
```

Tests sit beside their source under `src/`.

No live database: the pure builders and mappers are asserted directly, and the
store methods run against a fake `tx.execute` injected through
`@oxagen/database`'s `makeWithTenantDbMock`.
