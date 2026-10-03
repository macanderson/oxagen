# adopt_steering_merges

Adopt host merges of pull requests Oxagen opened on the workspace's steering repo, then publish main as the next steering version (#5195).

A steering repo reads `diverged` when main holds commits Oxagen did not merge. A pull request merged on GitHub proves nothing about who approved it, so a merge of one of Oxagen's own pull requests made on the host reads the same way. [`repair_steering_repo`](steering_repo.repair.md) then offers only the revert, which throws away the change. This capability is the other way out: a person the governance mode lets merge decides that those merges stand.

**Surfaces:** api, mcp, agent

## Mode

**sync**

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/context/steering/repo/adopt` with the body `{}` returns 200
- MCP: `adopt_steering_merges`
- Agent: Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: high`).
- CLI: none
- Authentication: an org Owner or Admin, or a workspace Owner or Member, checked by the handler (INV-29). The governance mode then decides, as it does for [`merge_steering_pr`](steering.pr.merge.md): any of them in `solo`, an org Owner or Admin or a workspace Owner other than the pull request's author in `team`, and an org Owner or Admin other than the author in `regulated`. A call that carries only an API key names no user and is refused `no_principal`
- Not billed (`noBillingGate: true`), IAM default-deny, high sensitivity

## Input

None. The org and workspace come from the capability context.

## Output

| Field | Type | Description |
|---|---|---|
| `health` | `healthy`, `drifted`, `disconnected`, or `diverged` | the health the read after the adoption found |
| `adopted` | `{ commit, pullRequest }[]` | each merge commit the call adopted and the pull request it merged |
| `publishedVersion` | integer or null | the steering version the call published. Null when the publish did not go live in the call, and the repository sync then publishes main |

## What an adoption does

The call runs in the repository's merge queue, so no merge lands while it reads main. It adopts every commit on main since the published one, or none.

1. Lists the commits on main since the published commit that no app merge proves. A main that no longer contains the published commit, or holds more commits than one read lists, is refused.
2. Proves each commit. GitHub must say a pull request merged into main as exactly that commit, and not by the steering app. A proposal row in this workspace must name that pull request, at the head the host merged. The commit must change exactly the files the pull request changes, with the same contents.
3. Checks the caller against the governance mode for each of those pull requests.
4. Posts the steering app's `Oxagen steering adoption` check run on each adopted commit. Only the app can post a run under its id, and every later history read counts a commit that carries it as Oxagen's. Nothing is written into the repository's history.
5. Emits `steering.published` with the adopter as its actor. Its detail names the repository, each adopted commit and pull request, and the published version.
6. Reads the health again, which reads `healthy`, and publishes main as the next steering version with its deployment.

A call made after every merge was adopted adopts nothing more, and publishes main if it is not published yet.

## Refusals

A refusal writes nothing, and Repair settings still offers the revert.

| Code | Reason | When |
|---|---|---|
| `forbidden` | `no_principal`, `org_role_required`, `separation_of_duties` | no signed-in user; a role the governance mode does not let merge; the caller opened the pull request in a mode that needs someone else |
| `not_found` | `steering_repo_not_ready` | the workspace has no steering repo that is ready |
| `conflict` | `nothing_to_adopt` | the steering repo does not read `diverged` |
| `conflict` | `adoption_unsupported` | the steering repo is on GitLab, which keeps its own trailer checks |
| `conflict` | `adoption_refused` | a commit landed without a pull request, its pull request was not opened by Oxagen, it merged at another head, or it changes other files. The message names the commit and the pull request |
| `conflict` | `steering_publication_missing` | the steering app recorded no published version to adopt the merges onto |
| `conflict` | `steering_app_unconfigured` | this deployment has no Oxagen GitHub App settings |
| `conflict` | `steering_repo_disconnected` | the organization no longer has a GitHub steering connection |
