# context.proposal.dismiss

**Name:** `dismiss_proposal`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** medium
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or the workspace Owner — checked by the handler (`assertOrgRole`, INV-29)

## Intent

Reject a proposal with a reason ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md)). A proposal with an open Context PR is rejected here too; the PR stays open on GitHub for its author to close, and the branch is never deleted. A merged proposal is published and cannot be dismissed; retirement is its own Context PR and is outside this release.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `prp_…` | |
| `reason` | `string` | 1–2000 characters |

## Output

`{ proposalId, status: "rejected" }`. Dismissing a rejected proposal again answers the same and keeps the first reason.

## Side effects

`context_proposals.status = 'rejected'`, `dismissed_at`, `dismissed_reason`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` / `no_principal` | The caller holds none of the accepted roles. |
| `not_found` | `proposal_not_found` | |
| `conflict` | `proposal_merged` | |
