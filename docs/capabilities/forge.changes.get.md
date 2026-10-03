# get_change_set

**Name:** `get_change_set`
**Domain:** run
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

The pull requests a run, a work order, a work item, or an issue produced, each with its latest stored revision and files, and their change rolled up by repository ([ADR-292](../adr/ADR-292-every-pull-request-read-comes-from-the-forge-store.md)). Every fact comes from Oxagen's own pull request store ([ADR-288](../adr/ADR-288-pull-requests-and-their-diffs-are-stored-in-the-forge-schema-and-s3.md)). Nothing is read from GitHub or GitLab.

## Input

`{ scope: run | work_order | work_item | issue, id }`

| Scope | `id` |
| --- | --- |
| `run` | The run's public id, `arun_…` or `tse_…` |
| `work_order` | The work order's public id, `wo_…` |
| `work_item` | The work item's public id, `wi_…` |
| `issue` | The issue's URL on GitHub or GitLab |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `scope` / `id` | as given | |
| `pullRequests[]` | `{ id: fpr_…, provider, repository, number, url, title, state, headSha, baseRef, headRef, mergedAt, closedAt, stateSeenAt, revision, files[], moreFiles }` | At most 100, newest first. `state` is `open`, `draft`, `merged`, or `closed` |
| `pullRequests[].revision` | `{ id: prv_…, headSha, mergeBaseSha, diffStatus, complete, limitations, filesChanged, additions, deletions, diffBytes, capturedAt }` or null | The latest head's revision, or the newest one while the latest head's is not captured. Null when none is captured |
| `pullRequests[].files[]` | `{ path, previousPath?, status, additions, deletions }` | At most 300 per pull request |
| `morePullRequests` | `boolean` | More pull requests are linked than one answer lists |
| `repositories[]` | `{ provider, repository, pullRequests, filesChanged, additions, deletions, files[], moreFiles }` | The roll-up, sorted by repository |

## Semantics

- **Run:** the run's links in `forge.pull_request_runs`, and, for a wrapped run, the pull requests its `tacho.run_pull_requests` rows name.
- **Work order:** the order's links in `forge.pull_request_work_orders`, and the pull requests its `pr_linked` facts name.
- **Work item:** every pull request its work orders produced, and every pull request that closes the issue it came from.
- **Issue:** every pull request whose closing references name the issue (`forge.pull_request_issues`), and every pull request of a work item that came from it.

A link that names a pull request the forge store has no row for yet is left out until that pull request's next delivery stores it.

**Net change.** A pull request's net change is its revision: the diff from the merge base to its latest head. The roll-up is per repository, as the union of files with summed line counts. A path two pull requests changed is one entry that names both. A pull request closed without merging changed nothing, so it is listed and left out of the roll-up. Hunks from different pull requests are never combined, because each starts from its own merge base. `get_revision_diff` reads a revision's hunks.

## Errors

| code | reason |
| --- | --- |
| `not_found` | `run_not_found`, `work_order_not_found`, `work_item_not_found`, or `issue_not_found`, for an id that does not fit its scope, or a work order or work item not in this workspace |
