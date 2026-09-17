# context.pr.get

**Name:** `get_context_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

One proposal's Context PR ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3): the state machine as stored, its checks with their outcomes, what merge will do, and the promotion event once merged. The read the Context PR panel polls while the checks run.

## Input

`{ proposalId: prp_… }`

## Output

`contextPrSchema` — see [context.pr.open](context.pr.open.md). On a `proposed` row `governanceMode` and `onMerge.review` are null: governance.toml is read when the PR opens, and the view carries what was read or nothing. `onMerge.bundleVersion.current` is the workspace's steering version: the length of the promotions ledger (`agent.context_promotions`); `afterMerge` is one more until the proposal is merged. `merged` carries the merge commit, the time, the merger, the promotion event (`ctp_…`) and the published record (`ctr_…`).

## Errors

| code | reason |
| --- | --- |
| `not_found` | `proposal_not_found` |
