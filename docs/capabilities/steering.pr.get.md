# get_steering_pr

**Name:** `get_steering_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

One proposal's steering PR ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3): the state machine as stored, its checks with their outcomes, what merge will do, and the promotion event once merged. The read the steering PR panel polls while the checks run.

## Input

`{ proposalId: prp_… }`

## Output

`steeringPrSchema` — see [steering.pr.open](steering.pr.open.md). On a `proposed` row `governanceMode` and `onMerge.review` are null: governance.toml is read when the PR opens, and the view carries what was read or nothing. `onMerge.bundleVersion.current` is the number of entries in the promotions ledger (`agent.steering_promotions`), one per merged record, and `afterMerge` is one more until the proposal is merged. It is not the steering version, which `merge_steering_pr` answers as `publishedVersion` (#4732). `merged` carries the merge commit, the time, the merger and their display name, whether the host merged it (`onHost`: the repository sync recorded it with no merger, ADR-184), the promotion event (`ctp_…`) and the published record (`ctr_…`).

`raised` is the proposal as raised: its statement, rationale, source (with `sourceName` when the source is a user with a display name), force, constraint effect, sharing scope, support and the instant it was raised. `closed` is set on a rejected proposal: the instant, the reason (null when none was given), the closer and their display name, and `onHost` when the host closed it and the repository sync or `refresh_steering_pr` recorded the close. A close on the host records no closer. A display name comes from `auth.users.display_name`; a user without one is named by nothing, never by email.

Two fields come after `steeringPrSchema`'s ([ADR-267](../adr/ADR-267-a-steering-pr-approval-is-stored-in-oxagen.md), #4518). Both are read from Postgres, so the page's poll reads no host.

| Field | Type | Notes |
| --- | --- | --- |
| `findings` | `{ rule, path, line, message }[]` | What the latest check run found on the head beyond the six outcomes. `rule` is `managed-block`: the PR changes the managed block in `AGENTS.md`, `CLAUDE.md`, or `README.md`, and [`restore_managed_block`](steering.pr.restore_managed_block.md) puts it back. Empty before a run finishes, in a legacy repository, and once a run finds the block matches the production branch |
| `approvals` | `int` | How many people approved the checked head in Oxagen with [`approve_steering_pr`](steering.pr.approve.md). A review on the host is not counted here. The merge counts both |

## Errors

| code | reason |
| --- | --- |
| `not_found` | `proposal_not_found` |
