# Stella Operational Telemetry Intake Implementation Plan

> **Scope:** Oxagen Enterprise companion for Stella phases 0 and 1. Stella remains the local execution engine; Oxagen receives only explicitly enrolled, content-free operational rollups.

## Invariants

- Every request enters through the API surface and the capability kernel `invoke()` path.
- The endpoint is API-key-only. Tenant scope comes exclusively from the authenticated API key context.
- Client `organization_id` and `workspace_id` fields are compatibility labels from the signed Stella enrollment. They are validated as bounded strings but never authorize or stamp storage rows.
- The wire schema exactly mirrors `stella.operational.batch.v1` containing 1..=50 strict `stella.operational.v1` `execution_rollup` events.
- No prompts, messages, reasoning, paths, tool arguments/results, source, stack traces, arbitrary JSON, installation identity, or local execution IDs are representable.
- Successful append returns `accepted`, never a claim that an event was uniquely inserted. Retry idempotency is eventual `ReplacingMergeTree` collapse keyed by authenticated tenant plus immutable `event_id`; exact reads use `FINAL`.
- Intake is a management operation and does not consume AI credits (`noBillingGate: true`). IAM remains default-deny and high-sensitivity.

## Task 1: Contract first

Files:

- Create `packages/oxagen/src/contracts/telemetry.stella.ingest.ts`
- Create `packages/oxagen/src/contracts/telemetry.stella.ingest.test.ts`
- Modify `packages/oxagen/src/contracts/index.ts`

Write failing tests for the exact strict batch/event allowlist, bounds, numeric non-negativity, identifier formats, output shape, API-only surface, scoped/high/default-deny metadata, Owner/Admin grants, and `noBillingGate`. Add the contract and barrel registration to make them green.

Focused command:

```bash
pnpm --filter @oxagen/oxagen test:unit -- src/contracts/telemetry.stella.ingest.test.ts
```

## Task 2: Tenant-safe append-only ClickHouse writer

Files:

- Create `packages/telemetry/src/stella-operational-events.ts`
- Create `packages/telemetry/src/stella-operational-events.test.ts`
- Modify `packages/telemetry/src/tenant.test.ts`
- Create `packages/telemetry/src/migrations/0026_stella_operational_events.sql`
- Create `packages/telemetry/src/stella-operational-idempotency.integration.test.ts`
- Modify `packages/telemetry/src/migrate.test.ts`
- Modify `packages/telemetry/src/index.ts`

Write failing tests proving the writer omits caller tenant labels and relies on `chInsert` to stamp ambient scope, hostile tenant columns are overwritten, migration shape is exact, and duplicate `event_id` retries collapse under `FINAL`. Use bounded typed columns only. Store `received_at` server-side and partition by its month; order by `(org_id, workspace_id, event_id)`.

Focused commands:

```bash
pnpm --filter @oxagen/telemetry test:unit -- src/stella-operational-events.test.ts src/tenant.test.ts src/migrate.test.ts
pnpm --filter @oxagen/telemetry test:unit -- src/stella-operational-idempotency.integration.test.ts
```

## Task 3: Governed handler and billing bypass witness

Files:

- Create `packages/handlers/src/telemetry.stella.ingest.ts`
- Create `packages/handlers/src/telemetry.stella.ingest.test.ts`
- Modify `packages/handlers/src/register.ts`
- Modify `packages/oxagen/src/kernel.test.ts`

Write failing tests proving the handler maps only the closed operational fields, awaits the primary ClickHouse write, ignores client tenant labels, and propagates writer failures. Register lazily under `ingest_stella_operational_telemetry`. Add an explicit kernel test proving `noBillingGate: true` skips the configured billing admission gate while IAM and the handler still run.

Focused commands:

```bash
pnpm --filter @oxagen/handlers test:unit -- src/telemetry.stella.ingest.test.ts
pnpm --filter @oxagen/oxagen test:unit -- src/kernel.test.ts
```

## Task 4: API-key-only thin route

Files:

- Create `apps/api/src/routes/v1/telemetry.stella.ingest.ts`
- Create `apps/api/src/routes/v1/telemetry.stella.ingest.test.ts`
- Modify `apps/api/src/app.ts`

Write failing route tests for API-key-only authentication, contract parsing, extra-field rejection, API-surface `invoke()`, authenticated context propagation, and no invocation on malformed input. Mount `POST /v1/telemetry/stella/operational` behind existing auth middleware. Do not add route-local IAM or billing logic.

Focused command:

```bash
pnpm --filter @oxagen/api test:unit -- src/routes/v1/telemetry.stella.ingest.test.ts
```

## Task 5: Capability docs, manifests, review, and CI

Files:

- Create `docs/capabilities/telemetry.stella.ingest.md`
- Regenerate `packages/oxagen/src/contracts.generated.ts`
- Regenerate `packages/oxagen/capabilities.manifest.json`

Run focused tests, `pnpm check:manifest --strict`, `pnpm check:contracts`, lint/typecheck for affected packages, and the one final `pnpm gate` only after implementation is complete. Dispatch independent correctness/security/tenancy review and fix every Critical or Important finding. Commit with DCO, push immediately, open a draft PR, drive required CI green, then mark ready for review.

