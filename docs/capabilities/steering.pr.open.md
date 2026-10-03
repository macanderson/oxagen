# open_steering_pr

**Name:** `open_steering_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: high`).
**Why no MCP or CLI:** The PR is opened from the operator console, and the CLI records the proposal with `oxagen context propose` (`propose_record`), so neither the MCP nor the CLI surface is declared. Adding the MCP tool is a lane of its own.
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or workspace Owner or Member — checked by the handler (`assertOrgRole`, INV-29) for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`; a key with no creator is refused `no_principal`), who is recorded as the proposal's updater (2026-09-15, maintainer decision)

## Intent

The pull request that publishes a proposal ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3 steps 1–2). On a `proposed` row:

1. the workspace's repository is the one its GitHub source connection names; its production branch is the repository's default branch. The repository's layout is read there: a repository with `steering/governance.toml` is a steering repository, and one without it is a legacy repository. The governance mode comes from `steering/governance.toml` in a steering repository and from `.oxagen/rules/governance.toml` in a legacy one (`team` when absent);
2. the branch, from the production branch;
3. the single record file, in the format the layout reads (#4731):

   | Layout | New record | Branch |
   | --- | --- | --- |
   | Legacy | `.oxagen/rules/<lineage>.toml`, in Stella's v0.1 record format, with `record_id` and `record_hash` stamped from the content the way Stella stamps them | `steering/<lineage>` |
   | Steering, any kind but memory | `steering/<kind folder>/<lineage>.md`, a steering record in steering-record/v1: `business-rules`, `constraints`, `procedures`, `facts`, or `preferences` | `steering/<lineage>` |
   | Steering, memory | `steering/memory/workspace/general/<lineage>.md`, where the memory curator puts a memory with no repository, path, or tool | `memory/<lineage>` |

   A revision is written where the record's file lives now, so a record a person moved on the host stays in one file. In a steering repository a revision keeps the fields the proposal does not set: `tools`, `skills`, `toolbelt`, `applies_to`, `load`, `repos` while the scope stays `repository`, and `description` while the statement stays the same. A steering record carries no `id` or `hash` until its steering PR merges, when Oxagen stamps both. A proposal's `rule` kind is written as `business-rule`, unless the record it revises is a `code-rule`;
4. the PR, whose body carries the rationale, the supporting records, runs and agents, the evidence links and the check list;
5. the six §10.3 checks, one at a time. Each outcome is written to the proposal before the next check starts, and all six are posted to the host as one required check, `Oxagen steering`, on the head commit. The file that is checked is the one read back from the branch.

A row that already names a branch keeps it. In a steering repository the Schema check also fails a branch that does not name the folder its paths are in, such as a `steering/` branch that changes `.oxagen/rules/`. A proposal opened before #4731 that wrote `.oxagen/rules/<lineage>.toml` in a steering repository fails that way on every run. Dismiss it and propose the record again.

The row records the branch before GitHub is touched. A call that failed after GitHub opened the PR is retried onto that PR, recognised by its body naming the proposal; an open PR on the branch whose body names another proposal is refused `lineage_pr_open`. The file's `origin` is `user` when a person raised the proposal and `inferred` when an agent did.

On a row whose PR is already open (`pr_open`, `checks_running`, `checks_passed`, `checks_failed`) the checks run again on the same PR, against its current head: the PR is refused `base_moved` when it no longer targets the production branch, `headSha` is re-read from GitHub, the file is read at that commit and the check runs are posted to it. Every status write applies only from the statuses it names, so a proposal dismissed or merged while the checks run is left as it is and the call is refused `proposal_rejected` or `proposal_merged`. A rerun on a proposal that `merge_steering_pr` is landing is refused `merge_in_progress` before GitHub is read, because the merge's stamp commit is the PR's head until GitHub merges it. A merge that claims the proposal after that refusal check makes the rerun's next status write refuse the same way. Each check write and the outcome write also require the row's head to be the one the checks read, so a re-run that recorded a newer head wins and this call is refused `head_moved`. Once every check passes the row carries the record's identity from that file: the `record_id` and `record_hash` stamped in a TOML file, or for a steering record the `id` and `hash` the merge will stamp. `merge_steering_pr` merges that commit and no other. One concern, one pull request: a second proposal on a lineage with an open PR is refused.

## On GitLab

When the workspace's main repository is a gitlab.com project (#3762), the same steps run through the GitLab implementation of the steering port (`context.steering.gitlab.ts`), picked from the binding's provider by `context.steering.host.ts`:

- the PR is a merge request, and `pr.number` is its IID, which is scoped to the project;
- the required check is a commit status named `Oxagen steering` on the head commit, with the title and summary as its description (255 characters at most);
- every call authenticates with the project access token `attach_gitlab_project` stored, and addresses the project by its numeric id, so a project moved to another group keeps working;
- the proposal records `provider = 'gitlab'`. A PR number is read back only through the host that issued it: if the workspace's main repository moved to the other host after the PR opened, re-running the checks is refused `repository_host_changed`.

A token GitLab no longer accepts is `conflict: gitlab_credential_rejected`, naming the project and nothing about the token. Any other GitLab refusal travels on `conflict: gitlab_refused`.

## The checks

A legacy record file and a steering record run the same six checks. Four of them read the file in its own format.

| name | passes when (legacy TOML file) | passes when (steering record) |
| --- | --- | --- |
| `schema` | The PR changes the record file and no other path (GitHub's compare from the production branch to the head; a rename counts both paths); the file is TOML, `schema = "context-record/v0.1"`, one `[[record]]` with a lineage, a kind from the six, a statement, an origin, a sharing scope, `status`, a stamped identity, provenance and `steering.force` | The PR changes the record file and no other path; the file reads as steering-record/v1. In a steering repository the branch must also name the file's folder |
| `lineage_uniqueness` | The file holds one record whose lineage is the file stem and the proposal's; no published record holds that lineage at another path | The file's `lineage` is the proposal's and names the file; no published steering record holds that lineage at another path |
| `record_hash` | `record_id` and `record_hash` recompute from the file's canonical bytes | The file carries no `id` or `hash` yet, or both recompute from its content |
| `secret_pii_scan` | No credential token, JWT, high-entropy blob, sensitive-key value or PEM block, and no email, SSN or Luhn-valid card number in the statement, rationale, evidence or file | The same |
| `conflict_against_active` | No active constraint of the opposite effect on the same lineage, or on the same statement under another lineage | The same |
| `constraint_effect` | The file's kind, `steering.force`, `sharing_scope` and statement are the proposal's (the registry is written from the proposal at merge); a constraint carries `require` or `forbid` and no other kind carries an effect | The file's `kind`, `force`, `scope`, statement and `label` are the proposal's (a `rule` may be a `business-rule` or a `code-rule`); a constraint carries an `effect` of `require` or `forbid` and no other kind carries one |

## Input

`{ proposalId: prp_… }`

## Output

The steering PR (`steeringPrSchema`, shared with `get_steering_pr`): `kind` (the record kind, or `governance` for a change to the governance mode, which runs no record checks and never merges without review), `status`, `governanceMode` (null until this call reads governance.toml), `pr` (number, url, provider, repository, baseRef, branch, headSha, path), `record` (recordId, recordHash, kind, force, constraintEffect, sharingScope, statement), `body`, `checks[]` (name, status, summary, detailsUrl, startedAt, completedAt), `onMerge` (what it publishes, the steering version before and after, who may merge under the mode — `review` null until the mode is read), `merged` (null until merged).

## Side effects

A branch, a commit and a pull request on the workspace's repository; one required check run, `Oxagen steering`, on the head commit; `steering_proposals` updated through `pr_open → checks_running → checks_passed | checks_failed`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` / `no_principal` | |
| `not_found` | `proposal_not_found` / `workspace_repository_missing` | No connected GitHub repository (MC spec §10.1). |
| `conflict` | `governance_proposal` / `steering_pr_proposal` | The proposal is a governance change or a steering PR that changes files rather than one record ([ADR-265](../adr/ADR-265-every-steering-pr-oxagen-opens-carries-a-proposal-row.md)), so the record checks do not apply. Set the mode again to run a governance change's checks. [`merge_steering_pr`](steering.pr.merge.md) runs a steering PR's checks before it merges. |
| `conflict` | `proposal_merged` / `proposal_rejected` / `lineage_pr_open` / `governance_unreadable` / `base_moved` / `head_moved` / `head_unknown` / `record_file_missing` / `repository_scope_needs_repo` / `record_unreadable` / `github_refused` / `gitlab_refused` / `gitlab_credential_rejected` / `repository_host_changed` / `merge_in_progress` | GitHub's message travels on `github_refused`; `merge_in_progress` when `merge_steering_pr` is landing the PR, or in a steering repository when a merge from Oxagen landed the PR and has not published it yet, so the caller merges it again to finish; `head_unknown` when GitHub reports no head commit for the PR; `base_moved` when the PR no longer targets the production branch; `head_moved` when a re-run recorded a newer head while these checks ran. In a steering repository, `repository_scope_needs_repo` when a proposal with `repository` scope revises no record that lists its `repos`, because a steering record with that scope must list them; `record_unreadable` when the proposal does not make a steering record. Both refuse before anything is written to the host. |
| `conflict` | `merged_outside_oxagen` | Someone merged the PR on the host at a commit the checks never passed on, so running them again cannot help: a merged PR's head never moves again. The call asks the repository sync to read the production branch, which publishes what merged ([ADR-184](../adr/ADR-184-the-registry-follows-the-production-branch.md)), and runs no checks. In a legacy repository, a PR merged on the host at the commit the checks passed on is not refused, and [`merge_steering_pr`](steering.pr.merge.md) publishes it. In a steering repository every merge from Oxagen lands a stamp commit, so a PR merged at any head other than Oxagen's stamp for it is refused, the commit the checks passed on included (#4504). |
