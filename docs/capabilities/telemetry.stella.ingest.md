# telemetry.stella.ingest

Accept content-free Stella execution rollups for an explicitly enrolled Oxagen Enterprise workspace. This is the Option A integration boundary: Stella remains the local execution engine and retains its raw operational telemetry; Oxagen receives only the closed operational rollup described below. A Stella client must first be enrolled and configured with a workspace API key and signed enrollment labels. This endpoint does not enroll a client.

## Mode

**sync**

## Surface

- API only: `POST /v1/telemetry/stella/operational`
- Authentication: workspace API key only; browser/session credentials are rejected
- Content type: `application/json`
- Maximum request body: 256 KiB

The request always enters the capability kernel as `ingest_stella_operational_telemetry`. Tenant scope comes exclusively from the authenticated API key context. The client-supplied `organization_id` and `workspace_id` fields are bounded compatibility labels from the signed Stella enrollment. Phase 1 intake does not compare them with the key-derived tenant; enrollment tooling is responsible for issuing the correct labels. They never authorize the request, are discarded before storage, and cannot change the storage tenant or idempotency key.

## Access and governance

This is a scoped, high-sensitivity management action. IAM is default-deny; the default organization grants allow only `Owner` and `Admin`, with no default workspace-role grants. It does not consume AI credits (`noBillingGate: true`).

The resulting records are operational telemetry, not compliance or audit evidence. Do not use this capability as a substitute for Oxagen security events, audit logs, execution lineage, or billing usage records.

## Input

The body must be the exact strict `stella.operational.batch.v1` object. Unknown fields at either the batch or event level are rejected. A batch contains 1 through 50 strict `stella.operational.v1` events.

| Field | Type | Required | Constraint |
|---|---|---|---|
| `schema` | string | yes | Exactly `stella.operational.batch.v1` |
| `events` | array | yes | 1–50 `execution_rollup` events |

Each event has exactly these fields:

| Field | Type | Constraint |
|---|---|---|
| `schema` | string | Exactly `stella.operational.v1` |
| `event_class` | string | Exactly `execution_rollup` |
| `event_id` | string | `evt_` followed by exactly 64 lowercase hexadecimal characters; immutable across retries |
| `enrollment_id` | string | 1–128 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-` |
| `organization_id` | string | 1–128 characters from the same bounded identifier alphabet; compatibility label only |
| `workspace_id` | string | 1–128 characters from the same bounded identifier alphabet; compatibility label only |
| `provider` | string | 1–160 characters from `A-Z`, `a-z`, `0-9`, `.`, `_`, `:`, `-`; cannot be `.` or `..` |
| `model` | string | 1–160 characters total; one or two `/`-separated segments, each using the provider alphabet and excluding `.` or `..` |
| `outcome` | string | One of `completed`, `error`, `failed`, `aborted`, `cancelled`, `indeterminate`, `verification_failed`, `goal_met`, `goal_unmet` |
| `duration_ms` | integer | Non-negative JavaScript safe integer |
| `input_tokens` | integer | Non-negative JavaScript safe integer |
| `output_tokens` | integer | Non-negative JavaScript safe integer |
| `cost_microusd` | integer | Non-negative JavaScript safe integer |
| `tool_call_count` | integer | Non-negative JavaScript safe integer |
| `changed_file_count` | integer | Non-negative JavaScript safe integer |
| `produced_output` | boolean | Whether the local execution produced an output |

The schema cannot represent prompts, messages, reasoning, filesystem paths, tool arguments or results, source text, stack traces, arbitrary JSON, installation identity, or Stella-local execution/call identifiers. Those values must remain local to Stella and must not be encoded into any bounded identifier or dimension field.

## Output

| Field | Type | Description |
|---|---|---|
| `accepted` | integer | Number of events whose append was accepted, 1–50 |
| `event_ids` | string[] | Accepted event identifiers in request order; length equals `accepted` |

`accepted` means Oxagen accepted the append. It does not mean an event was uniquely inserted, newly observed, or merged. Clients may safely retry the same immutable `event_id` after an ambiguous response.

## Append and retry semantics

Events are appended to ClickHouse with server-owned `received_at` and tenant identifiers stamped from ambient authenticated scope. Storage is append-only. Event identity is the authenticated `(org_id, workspace_id, event_id)` tuple.

Retries use eventual `ReplacingMergeTree` collapse. Because storage is partitioned by the month of `received_at`, exact deduplicated reads must use `FINAL` with cross-partition merging enabled (`do_not_merge_across_partitions_select_final = 0`). Non-`FINAL` reads may temporarily observe duplicate physical rows and must not be used to claim unique insertion.

Phase 1 trusts an explicitly enrolled Stella client to keep the entire operational event immutable when retrying an `event_id`; intake does not read before append or reject a conflicting payload. Reusing an `event_id` with altered stored dimensions is invalid client behavior. Under `FINAL`, `ReplacingMergeTree` selects the row with the greatest millisecond-resolution `received_at`; if conflicting versions have the same timestamp, the selected row is not defined. Identical retries are unaffected by such a tie. Conflict detection is required before these rollups can be treated as compliance-grade evidence.

## Example

```http
POST /v1/telemetry/stella/operational
Authorization: Bearer <workspace-api-key>
Content-Type: application/json

{
  "schema": "stella.operational.batch.v1",
  "events": [
    {
      "schema": "stella.operational.v1",
      "event_class": "execution_rollup",
      "event_id": "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "enrollment_id": "enrollment_01",
      "organization_id": "signed_org_label",
      "workspace_id": "signed_workspace_label",
      "provider": "anthropic",
      "model": "anthropic/claude-sonnet-4",
      "outcome": "completed",
      "duration_ms": 1200,
      "input_tokens": 200,
      "output_tokens": 50,
      "cost_microusd": 1750,
      "tool_call_count": 3,
      "changed_file_count": 1,
      "produced_output": true
    }
  ]
}
```

```json
{
  "accepted": 1,
  "event_ids": [
    "evt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  ]
}
```
