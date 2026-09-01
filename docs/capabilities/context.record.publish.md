# context.record.publish

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Risk level:** high (requires approval on the agent surface)
**Billing gate:** none (noBillingGate: true)

## Intent

Publish a steering context record into the workspace agent-asset registry — the platform mirror of adding a `.stella/rules/<record_id>.toml` file. Upserts the `agent.context_records` row by (workspace, record_id) and creates a new immutable version row when the body changed. Publishing the same body twice is idempotent (`published: false`).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| record_id | string | The record's stable id — the rules-file stem; the workspace-unique key |
| title | string | Human-readable record title |
| body | string | The canonical record body (one TOML record per file) |
| provenance | array (optional) | Where the record came from, in the ContextProvenanceV1 vocabulary: `{ type, uri?, range?, digest?, method?, by? }` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| publicId | string | Public record ID (`ctr_…`) |
| recordId | string | The record's stable id (slug) |
| version | integer | The version number now latest |
| checksum | string | SHA-256 hex over the body |
| published | boolean | false when the latest version already carried this checksum |

## Side effects

Inserts/updates `agent.context_records` and inserts `agent.context_record_versions`; repoints `context_records.active_version_id` at the new version. Never mutates an existing version row. Lifecycle status is NOT changed here — that is `context.record.promote`'s job.

## Errors

- Missing workspace scope → error (scoped capability).
- A record_id reserved by a soft-deleted record → conflict error naming the slug.
- Two concurrent publishes race safely: the loser republishes onto the winner's row.
