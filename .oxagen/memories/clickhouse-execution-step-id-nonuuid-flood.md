---
name: clickhouse-execution-step-id-nonuuid-flood
type: bug
domain: telemetry
severity: P1
linear: OXA-1813
date: 2026-06-23
---

**Symptom:** `POST /api/inngest` floods (hundreds/min) with
`[ERROR][@clickhouse/client] Insert: HTTP request error … Cannot parse input:
expected '"' before: '…' (while reading the value of key execution_step_id):
CANNOT_PARSE_INPUT_ASSERTION_FAILED (code 27)`.

**Root cause:** ingestion + image callers synthesized HUMAN-READABLE correlation
strings into the `token_usage.execution_step_id` ClickHouse `UUID` column:
`embed:<nodeId>`, `dedup:<naturalKey>`, `embed-file:<naturalKey>`,
`infer:<nodeId>`, `feat-infer:<key>`, `semantic-edge-infer:<nodeId>`, and the
literal `"unknown"`. ClickHouse's UUID text parser over-reads on the first
non-hex char into the next column and aborts the WHOLE row, so every such
insert dropped. The same string was also passed as `credit_ledger.reference_id`
(a Postgres `uuid`), so those ingestion-embedding credit charges threw and were
swallowed → **ingestion embeddings went UNBILLED** (silent revenue leak).

**Why NOT `Nullable(UUID)` (the obvious mirror of migration 0004):** 0004 made
`execution_logs.step_id` Nullable, but that column is NOT in its sorting key.
`token_usage.execution_step_id` IS in the sorting key
`ORDER BY (org_id, created_at, execution_step_id)`. ClickHouse FORBIDS converting
a key column to Nullable after creation — verified against 24.8:
`ALTER TABLE token_usage MODIFY COLUMN execution_step_id Nullable(UUID)` →
`Code 524 ALTER_OF_COLUMN_IS_FORBIDDEN` ("can change the representation of
primary key"), and this holds EVEN after `MODIFY SETTING allow_nullable_key = 1`.
The only route to a Nullable key is a full rebuild of this 365-day billing table —
pointless: nothing reads/joins on `execution_step_id` (pure tertiary sort
tie-breaker).

**Fix (code, no DDL on the column):** callers pass `null`/`undefined` for "no
execution step"; `@oxagen/telemetry`'s `insertTokenUsage` coalesces `null` → the
nil UUID `00000000-…-0` (`NIL_UUID`) at the single insert boundary (already the
established sentinel for `token_usage.workspace_id DEFAULT toUUID('0…0')`). The
billing `referenceId` is passed as `undefined` (→ NULL) instead of a non-UUID
string. The `…executionStepId`/`messageId` telemetry fields in `@oxagen/ai`
(`embed.ts`, `generate-image.ts`, `generate-object.ts`, `auto-improve.ts`) were
widened to `string | null`. Migration `0012` is a documented no-op recording the
decision; `schema.sql` column stays `UUID` with a warning comment.

**Guard:** `packages/telemetry/src/clickhouse.test.ts` — `insertTokenUsage`
coalesces null→NIL_UUID and passes real UUIDs through unchanged (mixed batch).
`packages/ai/src/embed.test.ts` — null `executionStepId` flows as null to
insertTokenUsage and `referenceId: undefined` to chargeUsageCredits.
`packages/ingestion/src/embed/embed-entity.test.ts` — `embedEntity` forwards
`executionStepId: null`, never `embed:<nodeId>`. Three pre-existing tests that
asserted the buggy `dedup:`/`infer:` strings were corrected to assert `null`.

**Watch-outs:** NEVER write a non-UUID correlation string into any `UUID`
ClickHouse column or `uuid` Postgres column. If a human-readable key is needed,
add a SEPARATE `String` column via a forward migration. The exact same class
recurs across every `embedText` / `generateObjectFor` / `generateImageFor`
caller — grep for `` executionStepId: ` `` / `` messageId: ` `` and `?? "unknown"`.
The CH UUID parse failure also greedily corrupts the _next_ column's value in the
error message, which can mislead diagnosis. See [[clickhouse-key-column-not-nullable]].
