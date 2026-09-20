# dismiss_proposal

**Name:** `dismiss_proposal`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Why api only:** Proposals are dismissed from the operator console, so the MCP surface is not declared. Adding the MCP tool is a lane of its own.
**Risk level:** medium
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or the workspace Owner — checked by the handler (`assertOrgRole`, INV-29) for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`; a key with no creator is refused `no_principal`), who is recorded as the proposal's updater (2026-09-15, maintainer decision)

## Intent

Reject a proposal with a reason ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md)). A proposal with an open Context PR has the PR closed on GitHub and its branch `context/<lineage>` deleted before the row changes, so the next proposal on the lineage opens a fresh branch and PR. A proposal whose open failed after GitHub opened the PR carries the branch and no PR number; its PR is found on the branch and closed, with the branch deleted, when the PR's body names this proposal and no other proposal on the lineage has recorded a PR there; a PR another proposal opened is left open. The `rejected` write applies only to a proposal that is not merged, so a merge that publishes while GitHub is being called keeps its proposal and the dismissal is refused `proposal_merged`. A merged proposal is published and cannot be dismissed; retirement is its own Context PR and is outside this release.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `prp_…` | |
| `reason` | `string` | 1–2000 characters |

## Output

`{ proposalId, status: "rejected" }`. Dismissing a rejected proposal again answers the same and keeps the first reason.

## Side effects

`context_proposals.status = 'rejected'`, `dismissed_at`, `dismissed_reason`; when the proposal had a PR, that PR closed and its branch deleted.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` / `no_principal` | The caller holds none of the accepted roles. |
| `not_found` | `proposal_not_found` | |
| `not_found` | `workspace_repository_missing` | The proposal has a PR and the workspace no longer has a connected repository. |
| `conflict` | `proposal_merged` / `github_refused` | GitHub's message travels on `github_refused`. |
