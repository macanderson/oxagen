# open_context_pr

**Name:** `open_context_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Why api only:** The PR is opened from the operator console, and the CLI records the proposal with `oxagen context propose` (`propose_record`), so neither the MCP nor the CLI surface is declared. Adding the MCP tool is a lane of its own.
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner or Admin, or workspace Owner or Member — checked by the handler (`assertOrgRole`, INV-29) for the acting user: the signed-in user, or the creator of the API key (`resolveActingUserId`; a key with no creator is refused `no_principal`), who is recorded as the proposal's updater (2026-09-15, maintainer decision)

## Intent

The pull request that publishes a proposal ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3 steps 1–2). On a `proposed` row:

1. the workspace's repository is the one its GitHub source connection names; its production branch is the repository's default branch; the governance mode is read from `.oxagen/rules/governance.toml` there (`team` when absent);
2. branch `context/<lineage>` from the production branch;
3. the single file `.oxagen/rules/<lineage>.toml` in context-record/v0.1 (Stella's layout), with `record_id` and `record_hash` stamped from the content the way Stella stamps them;
4. the PR, whose body carries the rationale, the supporting records, runs and agents, the evidence links and the check list;
5. the six §10.3 checks, one at a time — each outcome is written to the proposal before the next check starts and mirrored to GitHub as a check run (`Oxagen · <check>`) on the head commit. The file that is checked is the one read back from the branch.

The row records the branch before GitHub is touched. A call that failed after GitHub opened the PR is retried onto that PR, recognised by its body naming the proposal; an open PR on the branch whose body names another proposal is refused `lineage_pr_open`. The file's `origin` is `user` when a person raised the proposal and `inferred` when an agent did.

On a row whose PR is already open (`pr_open`, `checks_running`, `checks_passed`, `checks_failed`) the checks run again on the same PR, against its current head: the PR is refused `base_moved` when it no longer targets the production branch, `headSha` is re-read from GitHub, the file is read at that commit and the check runs are posted to it. Every status write applies only from the statuses it names, so a proposal dismissed or merged while the checks run is left as it is and the call is refused `proposal_rejected` or `proposal_merged`. Each check write and the outcome write also require the row's head to be the one the checks read, so a re-run that recorded a newer head wins and this call is refused `head_moved`. Once every check passes the row carries the `record_id` and `record_hash` stamped in that file, and `merge_context_pr` merges that commit and no other. One concern, one pull request: a second proposal on a lineage with an open PR is refused.

## The checks

| name | passes when |
| --- | --- |
| `schema` | The PR changes the record file and no other path (GitHub's compare from the production branch to the head; a rename counts both paths); the file is TOML, `schema = "context-record/v0.1"`, one `[[record]]` with a lineage, a kind from the six, a statement, an origin, a sharing scope, `status`, a stamped identity, provenance and `steering.force` |
| `lineage_uniqueness` | The file holds one record whose lineage is the file stem and the proposal's; no published record holds that lineage at another path |
| `record_hash` | `record_id` and `record_hash` recompute from the file's canonical bytes |
| `secret_pii_scan` | No credential token, JWT, high-entropy blob, sensitive-key value or PEM block, and no email, SSN or Luhn-valid card number in the statement, rationale, evidence or file |
| `conflict_against_active` | No active constraint of the opposite effect on the same lineage, or on the same statement under another lineage |
| `constraint_effect` | The file's kind, `steering.force`, `sharing_scope` and statement are the proposal's (the registry is written from the proposal at merge); a constraint carries `require` or `forbid` and no other kind carries an effect |

## Input

`{ proposalId: prp_… }`

## Output

The Context PR (`contextPrSchema`, shared with `get_context_pr`): `status`, `governanceMode` (null until this call reads governance.toml), `pr` (number, url, repository, baseRef, branch, headSha, path), `record` (recordId, recordHash, kind, force, constraintEffect, sharingScope, statement), `body`, `checks[]` (name, status, summary, detailsUrl, startedAt, completedAt), `onMerge` (what it publishes, the steering version before and after, who may merge under the mode — `review` null until the mode is read), `merged` (null until merged).

## Side effects

A branch, a commit and a pull request on the workspace's repository; up to six GitHub check runs; `context_proposals` updated through `pr_open → checks_running → checks_passed | checks_failed`.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `org_role_required` / `no_principal` | |
| `not_found` | `proposal_not_found` / `workspace_repository_missing` | No connected GitHub repository (MC spec §10.1). |
| `conflict` | `proposal_merged` / `proposal_rejected` / `lineage_pr_open` / `governance_unreadable` / `base_moved` / `head_moved` / `head_unknown` / `record_file_missing` / `github_refused` | GitHub's message travels on `github_refused`; `head_unknown` when GitHub reports no head commit for the PR; `base_moved` when the PR no longer targets the production branch; `head_moved` when a re-run recorded a newer head while these checks ran. |
