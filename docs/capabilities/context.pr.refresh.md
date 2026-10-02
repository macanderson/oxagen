# refresh_context_pr

**Name:** `refresh_context_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`), because it writes only what the host already shows.
**Why no MCP:** The handler gates on the acting user's role, as `open_context_pr` does, and the Context PR page is where a person asks for it. Adding the MCP tool is a lane of its own.
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or a workspace Owner or Member — checked by the handler (`assertOrgRole`, INV-29) for the acting user (`resolveActingUserId`)

## Intent

Read one proposal's Context PR from GitHub or GitLab now and move the proposal to what the host says ([ADR-184](../adr/ADR-184-the-registry-follows-the-production-branch.md) decision 5). The webhook and the five-minute sweep already do this for every open Context PR through the repository sync. This is the one-PR path: the Context PR page calls it once when it opens, so a missed webhook never leaves the page showing a state the host does not agree with, and its Refresh from GitHub button calls it on demand (#5077).

## Input

`{ proposalId: prp_… }`

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `prp_…` | |
| `status` | the state machine | The proposal's status after the refresh |
| `host` | `{ state: open \| merged \| closed, headSha, baseRef } \| null` | What the host says; null before a pull request opens |
| `changed` | `boolean` | The refresh moved the proposal |
| `syncRequested` | `boolean` | The host merged the pull request and the repository sync was asked to publish it |

## Semantics

The host is read first, and nothing is written when the read fails.

- **Closed on the host without merging:** the proposal moves to `rejected` with the sync's reason (`Closed on GitHub without merging`) and no updater, which `get_context_pr` reads as a close on the host. The branch is deleted; a branch already gone is not an error.
- **Merged on the host:** the repository sync publishes it, or rejects one it cannot publish, through the per-workspace queue. This request never publishes, so it asks for a sync and answers `syncRequested: true` with the status unchanged.
- **Open with a head the checks did not run on:** the checks reset to pending and the status to `pr_open`, as the sync does.
- A merged or rejected proposal, and one `merge_context_pr` has claimed, are not moved; the host's state still comes back.

Every write is the sync's compare-and-set on the status, the head and the merge claim. A proposal another call moved first is answered as it stands now, so a second call moves nothing.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` / `no_principal` | The caller holds none of the accepted roles. |
| `not_found` | `proposal_not_found` | |
| `not_found` | `workspace_repository_missing` | The workspace no longer has a connected repository. |
| `conflict` | `repository_host_changed` | The pull request was opened on another host than the one the workspace binds now. |
| `conflict` | `github_refused` | The host refused the read, for example a token without access or a repository the App no longer reaches. The host's message travels with it. |
