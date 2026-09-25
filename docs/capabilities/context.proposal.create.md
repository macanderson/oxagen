# propose_record

**Name:** `propose_record`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium (no approval — the Context PR is the review)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or workspace Owner or Member — checked by the handler (`assertOrgRole`, INV-29) for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`); a key with no creator is refused `no_principal` (2026-09-15, maintainer decision). The proposal's author stays the signed-in user, null for a key, so its Context PR stamps origin `inferred`

## Intent

A proposal on a lineage ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §9.2, App. E): the record it should become, why, and the support it cites. A proposal steers nothing; it is published when its Context PR merges (spec §10.3). Proposals appear on the Steering page's Proposals tab.

In the app, the context-record wizard calls it. **Write a context record** on every Steering tab but Skills, or ⌘K **Create › Context record**, opens the wizard. Its last step sends the record the operator chose with the description as the rationale, then calls `open_context_pr` on the new proposal, so the record exists only when that pull request merges (roadmap creation-spec §5). When the open fails, a retry reuses the proposal rather than proposing a second one.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `record.lineageId` | `string` | Lowercase letters, digits, dots and hyphens — the file stem under `.oxagen/rules/` |
| `record.label` | `string`? | The record's name, 1–36 characters. Labels need not be unique. Omit it to keep the current label, or to derive one from the lineage on a new record |
| `record.kind` | `rule \| constraint \| procedure \| fact \| memory \| preference` | |
| `record.force` | `must \| should \| may \| info` | |
| `record.constraintEffect` | `require \| forbid`? | Required on a constraint, refused on every other kind. `allow` is unrepresentable |
| `record.sharingScope` | `workspace \| repository` | Decides which repo the Context PR targets |
| `record.statement` | `string` | The single-sentence claim, 1–2000 characters |
| `rationale` | `string` | 1–4000 characters |
| `source` | `string`? | Who raised it, as the page prints it; defaults to the calling principal (`user:<id>`, `api_key:<id>`) |
| `support.runs[]` / `.agents[]` / `.recordIds[]` / `.evidenceLinks[]` | `string[]` | Supporting runs, distinct agents, appended records, evidence; each defaults to empty |
| `createOnly` | `boolean`? | Refuse a lineage that already names a record or a proposal, with `clone_name_taken`, instead of proposing a new version of it. The wizard sets it: labels need not be unique, so two records can derive the same slug ([ADR-173](../adr/ADR-173-context-record-labels.md)) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | `agent.context_proposals.public_id` (`prp_…`) |
| `lineageId` | `string` | |
| `status` | `"proposed"` | |

## Side effects

One `agent.context_proposals` row in the `proposed` state.

## Errors

| code | meaning |
| --- | --- |
| `forbidden` | A signed-in caller holds none of the accepted roles (`org_role_required`). |
| `invalid_input` | A constraint without an effect, an effect on another kind, a lineage id that is not a file stem. |
| `conflict` | `createOnly` was set and the lineage already names a record or a proposal (`clone_name_taken`). |
