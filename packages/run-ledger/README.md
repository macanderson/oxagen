# `@oxagen/run-ledger`

The durable **evidence ledger** for governed agent runs. It is the only writer
of the `agent.agent_runs*` tables, and it executes nothing.

[ADR-041](../../docs/adr/ADR-041-runtime-excision.md) removed Oxagen's agent
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

## Modules

| File | What it owns |
|---|---|
| `run-spec-v2.ts` | The trusted admission contract. Built only by server code, never from a request body: surfaces parse caller input with `parseCallerRunInfluence` and hand it to `buildTrustedRunSpecV2` alongside separately-resolved trusted sections. Also RFC 8785 canonical JSON and the run-row ↔ spec identity comparison. |
| `event-payload-registry.ts` | The closed event vocabulary (nine evidence stages), the inline-payload allow list and byte cap, the forbidden raw-content roots, and the event / stream digest contract a finalizer must reproduce byte for byte. |
| `run-store.ts` | The ledger itself: run admission, immutable attempts, appends, seals, terminal outcome, and the read side. Every SQL builder and row mapper is a pure exported function. |
| `finalization-grant.ts` | The one-shot, non-expiring finalization grant and its durable obligation, minted in the same transaction as every seal. |
| `run-errors.ts` | Typed, dependency-free errors with stable `code` discriminants plus structural guards. |
| `surface.ts` | Which platform surface admitted a run. |

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
  reported to the injected `RunSecurityEventSink` *after* the transaction rolls
  back. The insert deliberately carries no `ON CONFLICT` clause.
- **A zero-event attempt seals honestly.** Null final-event digest, the
  canonical empty-stream digest, no synthesized terminal event.
- **Seal, grant and obligation are one transaction.** A seal without its grant
  would be evidence nobody may finalize; a grant without its obligation would be
  authority nobody is scheduled to use. A duplicate seal returns the *same*
  handle — above all the same `submission_id`.
- **Tenant-scoped throughout.** Every method runs under `withTenantDb`; RLS from
  the caller's ambient scope is the tenant filter. The cross-tenant
  `withSystemDb` paths left with the worker pool and the lease sweeper.

## Testing

```bash
pnpm --filter @oxagen/run-ledger test:unit
```

No live database: the pure builders and mappers are asserted directly, and the
store methods run against a fake `tx.execute` injected through
`@oxagen/database`'s `makeWithTenantDbMock`.
