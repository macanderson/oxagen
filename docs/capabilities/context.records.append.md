# context.records.append

**Name:** `append_record`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low (no approval)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or workspace Owner or Member — checked by the handler for a signed-in caller (`assertOrgRole`, INV-29); an API-key call carries no user and is authorized by the kernel

## Intent

The protocol's `context/append` for agents ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §9): an observation, a memory, a knowledge claim, evidence, a record of context being used, or a record proposal. Content-addressed by `record_hash` — SHA-256 over the RFC 8785 canonical bytes with Stella's null-stripping, computed by `recordHash` in `packages/run-evidence` — and idempotent per workspace: appending the same content again answers the first record.

An agent may only propose a directive. `kind: "directive"` is refused with `directive_requires_context_pr`; a directive becomes active only through a Context PR (spec §10).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | `observation \| memory \| knowledge \| evidence \| record_proposal \| context_use \| context_use_feedback` (or `directive`, refused) | The §9 kinds |
| `lineageId` | `string` | The idea this record belongs to |
| `statement` | `string` | 1–4000 characters |
| `sharingScope` | `repository \| workspace` | Default `workspace`; the scopes a workspace read enforces (`user` and `organization` are refused at the schema) |
| `sourceRefs[]` | `string[]` | Frames (`frame:<run>/<seq>`) and records it derives from |
| `evidenceLinks[]` | `string[]` | Frames or tool outputs by digest |
| `proposal` | `{ kind, force, constraintEffect?, rationale }`? | Required on `record_proposal`, refused on every other kind |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `recordId` | `string` | `agent.context_appends.public_id` (`cta_…`) |
| `recordHash` | `sha256:…` | |
| `kind` | the seven kinds | |
| `appended` | `boolean` | False when a record with this hash already existed |
| `proposalId` | `string \| null` | The proposal a `record_proposal` opened (`prp_…`) |

## Semantics

- Every append is read back by any principal in its workspace (`get_record`, `list_records`), so the write admits only the scopes that read enforces: `workspace` and `repository`. Spec §9's `user` and `organization` keys are refused by the input schema until a read path enforces them.
- A `record_proposal` also opens a proposal (`agent.context_proposals`, state `proposed`) through the same code path as `propose_record`; the two scopes are the ones a Context PR can publish to.
- Two identical appends read the first back; the unique `(workspace_id, record_hash)` index holds the race.

## Side effects

One `agent.context_appends` row (INSERT-only for the application role) and, for a `record_proposal`, one `agent.context_proposals` row.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` | A signed-in caller holds none of the accepted roles. |
| `conflict` | `directive_requires_context_pr` | A directive reaches the workspace only through a Context PR. |
| `conflict` | `proposal_fields_required` / `proposal_fields_refused` | `proposal` is present exactly on `record_proposal`. |
| `conflict` | `constraint_effect_mismatch` | A constraint declares `require` or `forbid`; no other kind carries an effect. |
