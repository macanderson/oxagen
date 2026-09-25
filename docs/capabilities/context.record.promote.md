# promote_context_record

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Risk level:** high (requires approval on the agent surface)
**Billing gate:** none (noBillingGate: true)

## Intent

Append a lifecycle action to a context record's hash-chained promotions ledger (`agent.context_promotions`) and apply it to the record row. Mirrors Stella's `.stella/rules/promotions.jsonl`: each entry commits to its predecessor via `chain_digest = sha256(prev_chain_digest + canonical row)`, so a rewritten or reordered ledger fails re-verification. The ledger is append-only at the database grant level.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| record_id | string | Public record ID (`ctr_…`) or its stable id (slug) |
| action | `promote` \| `retire` \| `supersede` | promote pins a version active; retire ends the record's life; supersede marks it replaced |
| version_id | string (optional) | Public version ID (`crv_…`) the action names — required for promote |
| policy_version | string | The governance policy version this action was taken under |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| recordId | string | Public record ID (`ctr_…`) |
| action | string | The action appended |
| seq | integer | This entry's position in the record's chain (1-based) |
| chainDigest | string | SHA-256 hex chain digest of this ledger entry |
| status | string | The record's lifecycle status after the action |

## Side effects

Inserts one `agent.context_promotions` row and updates `context_records.status` (and, for promote, `active_version_id`). A promote also refreshes the record row's `kind`, `force`, `constraint_effect`, and `statement` from the version it pins, so the row and the steering text compiled from it describe the version in service rather than the one merged last. A version the legacy `publish_context_record` path wrote carries no classification of its own, and the row keeps what it has. The approver recorded on the ledger row is the calling user.
- **Promoting a record is what makes it steer.** Every active `must` or `should` record in the workspace is compiled into the policy bundle's `context.system`, and a promote moves the bundle etag, so each enrolled host fetches the new text on its next poll (ADR-091, which supersedes ADR-051's per-turn delivery). Before this, a promoted record changed nothing about how an agent behaved.

## Errors

- Unknown record, or a version that does not belong to the record → error.
- `promote` without `version_id` → error.
- A record whose file lives under `.oxagen/rules/` → `conflict: record_follows_repository`. The repository sync (ADR-182) follows the file, so a change made here would revert on the next sync. Change the file with a Context PR instead.
- A racing double-append trips the `(record_id, seq)` unique index rather than forking the chain.
