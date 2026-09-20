# publish_context_record

**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Risk level:** high (requires approval on the agent surface)
**Billing gate:** none (noBillingGate: true)

## Intent

Publish a steering context record into the workspace agent-asset registry — the platform mirror of adding a `.stella/rules/<record_id>.toml` file. Upserts the `agent.context_records` row by (workspace, record_id) and creates a new immutable version row when the body or the classification changed. Publishing the same body under the same classification twice is idempotent (`published: false`).

Requires the same classification a merged Context PR carries (`kind`, `force`, `statement`): `readWorkspaceSteering` only ever delivers a `must` or `should` record to an agent, so a record with no `force` sits in the registry and never steers anything (#3302). A workspace whose `context_record_versions` table predates migration `20260918160000` writes the classification onto the record row only, until that migration runs; every read still gets the record row's classification.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| record_id | string | The record's stable id — the rules-file stem; the workspace-unique key |
| title | string | Human-readable record title |
| body | string | The canonical record body (one TOML record per file) |
| kind | string | One of `rule`, `constraint`, `procedure`, `fact`, `memory`, `preference` |
| force | string | One of `must`, `should`, `may`, `info`. Only `must` and `should` ever reach an agent |
| constraintEffect | string (optional) | One of `require`, `forbid`. Required when `kind` is `constraint`, refused on every other kind |
| statement | string | The single-sentence claim the record makes, 1 to 2000 characters |
| provenance | array (optional) | Where the record came from, in the ContextProvenanceV1 vocabulary: `{ type, uri?, range?, digest?, method?, by? }` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| publicId | string | Public record ID (`ctr_…`) |
| recordId | string | The record's stable id (slug) |
| version | integer | The version number now latest |
| checksum | string | SHA-256 hex over the body |
| published | boolean | false when the latest version already carried this checksum and this classification |

## Side effects

Inserts/updates `agent.context_records` and inserts `agent.context_record_versions`; repoints `context_records.active_version_id` at the new version. Never mutates an existing version row. Lifecycle status is NOT changed here — that is `context.record.promote`'s job. A record whose `force` is `must` or `should` is active steering as soon as it publishes: nothing else has to promote it, unlike a record that arrives through a Context PR.
- **A record with `force: must` or `force: should` now steers every turn in the workspace.** It enters as a volatile message immediately after the system prompt, before recalled memory and the instruction — not in the cached prefix (ADR-051). A record with `force: may` or `force: info` publishes and lists, but never reaches an agent.

## Errors

- Missing workspace scope → error (scoped capability).
- `conflict: provisional` — the workspace is the onboarding gate's and no main repository is bound yet (`org.onboarding_state.main_repo_bound_at` is null); `bind_main_repository` clears it. Checked before any write. A workspace from before the gate has no row and is never refused here.
- A record_id reserved by a soft-deleted record → conflict error naming the slug.
- Two concurrent publishes race safely: the loser republishes onto the winner's row.
