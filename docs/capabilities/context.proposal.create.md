# context.proposal.create

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

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `record.lineageId` | `string` | Lowercase letters, digits, dots and hyphens — the file stem under `.oxagen/rules/` |
| `record.kind` | `rule \| constraint \| procedure \| fact \| memory \| preference` | |
| `record.force` | `must \| should \| may \| info` | |
| `record.constraintEffect` | `require \| forbid`? | Required on a constraint, refused on every other kind. `allow` is unrepresentable |
| `record.sharingScope` | `workspace \| repository` | Decides which repo the Context PR targets |
| `record.statement` | `string` | The single-sentence claim, 1–2000 characters |
| `rationale` | `string` | 1–4000 characters |
| `source` | `string`? | Who raised it, as the page prints it; defaults to the calling principal (`user:<id>`, `api_key:<id>`) |
| `support.runs[]` / `.agents[]` / `.recordIds[]` / `.evidenceLinks[]` | `string[]` | Supporting runs, distinct agents, appended records, evidence; each defaults to empty |

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
