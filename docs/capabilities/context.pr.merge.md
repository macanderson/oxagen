# merge_context_pr

**Name:** `merge_context_pr`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. Each call waits for a person's approval (`riskLevel: high`).
**Why no MCP:** The reviewer is a signed-in user; an API key (the MCP bearer) carries none and is refused `no_principal`, so the MCP surface is not declared.
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** by governance mode, checked by the handler (INV-29) — see below

## Intent

Merge is the publication ([ADR-061](../adr/ADR-061-steering-governance-mode-thresholds-and-the-reflector.md); MC spec §10.3 steps 3–4). Refused until every check passed. Refused unless the caller is a reviewer the governance mode allows, read on the production branch at merge time from `steering/governance.toml` in a steering repository, or from `.oxagen/rules/governance.toml` in a legacy one:

| mode | who merges |
| --- | --- |
| `solo` | any workspace member (org Owner/Admin, workspace Owner/Member), the author included |
| `team` | an org Owner or Admin, or a workspace Owner, other than the author |
| `regulated` | an org Owner or Admin other than the author; recorded on the ledger row as the accountable approver |

Outside `solo` mode the PR also needs an approval on the host at the head that merges. The approver is a workspace member other than the author, and their host account is linked to an Oxagen user. Without one, an org Owner, a workspace Owner, or a member who holds [`merge_pr_without_review`](context.pr.merge_without_review.md) may still merge, and the ledger line and the trailers record that nobody reviewed it. Oxagen refuses anyone else with `approval_required`.

GitLab does not say which commit a reviewer approved. On GitLab the merge reads when each approval was given and when GitLab recorded each diff version of the merge request. An approval counts for the newest version GitLab recorded before it. GitLab keeps an approval across a rebase, because the rebase leaves the diff's patch unchanged. So an approval given before the merge queue rebased the branch counts for the old head, and the reviewer approves again. An approval given before GitLab records the version of a push counts for the version before it. When GitLab has not yet recorded the current head as a version, the merge is refused `gitlab_refused`, and a merge a minute later can pass. GitLab documents `approved_at` on every approval. An approval that GitLab reports with no readable `approved_at` cannot be placed on a head, so the merge is refused `approvals_not_head_bound`, owners included.

The merge also reads the project's "Reset approvals on push" setting. With the setting off, or hidden from the token (403 or 404), Oxagen refuses the merge with `approvals_not_head_bound`, owners included, and nothing merges. Any other failed read of the setting is refused `gitlab_refused` with GitLab's error. Oxagen turns the setting on when it provisions a steering repo. A project provisioned before this change keeps its setting until someone turns it on. The setting needs GitLab Premium.

The merge is pinned to the commit the checks ran on: the PR's head is read from GitHub and the call is refused `head_moved` when it is no longer the row's `headSha`, and `base_moved` when the PR no longer targets the production branch; the merge request carries that sha so GitHub refuses a race with 409. The published body is the file at that commit. A PR GitHub already reports merged (an earlier call whose publication failed) is not merged again; its merge commit and its merge instant are taken from GitHub and the publication resumes. The publication is stamped with that instant and never with this call's clock: a call that cannot read it is refused `merge_time_unknown` and publishes nothing, because `latestPublication` orders by that stamp and a guess can name an ancestor as the commit a checkout must reach. The head branch is deleted before the publication, so the next proposal on the lineage branches from the production branch that holds the squash. The PR is merged on GitHub first (squash; GitHub's own branch protection applies). Only a merge GitHub confirmed publishes the record: the registry row (`agent.context_records`) gains the classification and the merge commit, a new immutable version holds the file as merged, the promotion event is appended to the hash-chained ledger (`agent.context_promotions`, `action = promote`, `policy_version = governance:<mode>`), the proposal moves to `merged`, and `steering.published` is emitted to the audit log.

Before it lands the PR, the call claims the proposal for ten minutes (`merge_claimed_at`). The merge writes a stamp commit to the PR, and that commit is the PR's head until the host merges it. While the claim stands, a second merge, a check rerun (`open_context_pr`), and a dismissal are refused `merge_in_progress`, and the repository sync leaves the proposal alone. The publication clears the claim. A landing that fails before the host merged releases it. A landing that fails after the host merged keeps it, and the next call resumes the merge. A claim that a crash left behind lapses after ten minutes.

In a steering repository the merge publishes a steering version (#4732). Its number is the one publish() assigns next from the repository's version store, and the merge commit's `Oxagen-Version` trailer carries it. Provisioning publishes the repository's first commit as version 1, so the first merged steering PR publishes version 2, whether or not a repository sync ran first. `publishedVersion` answers that number. It is null when publish() failed, refused, or found the production branch moved, and the repository sync then publishes the production branch. A legacy repository has no version store: its trailer carries the ledger length plus one, and `publishedVersion` is null. `bundleVersion` counts promotion ledger entries, one per merged record. It is not the steering version: the first commit, and each commit the repository sync publishes, adds a version and no ledger entry.

### A governance proposal

In a steering repository under `team` or `regulated`, `set_governance_mode` records its review-route PR as a proposal of kind `governance` on the lineage `governance` ([ADR-232](../adr/ADR-232-a-steering-repositorys-governance-mode-changes-through-a-steering-pr.md), #4795). This capability lands it through the same queue, reviewer rule, claim, and approvals as a record, with these differences:

- The merge reads `steering/governance.toml` at the head and refuses `governance_invalid` when it is not governance/v1, such as `[memory] auto_merge = true` outside `solo`. It runs the steering checks on that head against the production branch, and again after each update the queue makes. A failure marks the proposal `checks_failed`, refuses `checks_failed`, and merges nothing.
- The merge needs an approval by a workspace member other than the author. An owner, or a holder of `merge_pr_without_review`, is refused `review_required` when no approval stands, and `merge_pr_without_review` refuses a governance proposal. Apply now in `set_governance_mode` is the recorded override.
- The commit title is `steering: set governance mode to <mode> (#n)`, and the ledger line names the approvers.
- The merge publishes no record and appends no promotion event. The proposal moves to `merged` with the merge commit and the merger, and the call emits `steering.governance_changed`. Its detail carries `approvedBy` and `proposalId`. It emits no `steering.published` and no `steering.governance_overridden`.

The repository sync does not yet record a governance PR merged outside Oxagen, and leaves its proposal open (#4795).

### A steering PR proposal

Every steering PR Oxagen opens carries a proposal row ([ADR-265](../adr/ADR-265-every-steering-pr-oxagen-opens-carries-a-proposal-row.md), #5122). Its kind names the PR:

| kind | the PR |
| --- | --- |
| `revert` | the PR [`revert_steering_pr`](context.pr.revert.md) opens |
| `tools` | a `tools/` PR from Studio's Review, the server sync, or the server folder writer |
| `import` | the Markdown import's `steering/import-<date>` PR, and each steering PR [`import_workspace_steering`](steering_repo.import.md) opens from `.oxagen/` |
| `memory_pr` | a `memory/<date>` PR from the curator or [`promote_memories`](steering.memories.promote.md) |
| `agent_file` | the PR that adds `agents/<name>.toml` when a host enrolls |
| `agent_proposal` | the PR an agent opens with `propose_steering` |
| `workspace` | the `workspace.toml` PR [`link_repository`](repository.link.md) and [`unlink_repository`](repository.unlink.md) open |

The row's lineage is the PR's branch, and its path is the folder every changed file sits under. A revert of a record PR takes the record's lineage and path instead. This capability lands the PR through the same queue, reviewer rule, claim, approvals, stamp, and trailers as a record, with these differences:

- The merge starts from any open status, because it runs the steering checks itself. It runs them on the head the row names against the production branch, reports the "Oxagen steering" check, and runs them again after each update the queue makes. A failure marks the proposal `checks_failed`, refuses `checks_failed`, and merges nothing.
- The merge reads no record body, so it never refuses `record_file_missing`. The commit title is `steering: merge <branch> (#n)`. Once merged, publish() makes the production branch the next steering version, and the call emits `steering.published`.
- A merged revert retires each registry record whose file it deleted. The record's status becomes `retired` at the merge commit, and a `retire` promotion event joins its chain with the merger as approver. A revert that restores an earlier version of a file leaves the registry as it is.
- A PR someone merged on the host carries no merge claim, so the call asks the repository sync to read it and refuses `merged_outside_oxagen`.
- Only a steering repository merges one. A legacy repository refuses `steering_repo_required`.

A merged `must` or `should` record reaches agents through the signed policy bundle: it is compiled into `context.system`, which changes the bundle etag, so every enrolled host in the workspace fetches it on its next poll (ADR-091). Delivery into context frames (spec §10.4) is not built yet.

## Input

`{ proposalId: prp_… }`

## Output

A union on `kind`. A record proposal answers the record arm:

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `status` | `"merged"` | |
| `kind` | `rule`, `constraint`, `procedure`, `fact`, `memory`, or `preference` | The record's kind |
| `record` | `{ id (ctr_…), lineageId, version, path }` | The published record and the version this merge created |
| `mergedCommit` | `string` | GitHub's merge commit |
| `promotionEvent` | `{ id (ctp_…), seq, chainDigest }` | The ledger entry |
| `bundleVersion` | `{ before, after }` | The number of promotion ledger entries before and after. It counts merged records, not steering versions |
| `publishedVersion` | `number` or `null` | The steering version this merge published, the number in its `Oxagen-Version` trailer. Null in a legacy repository, and null when publish() did not make the version live |

A governance proposal answers the governance arm:

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `status` | `"merged"` | |
| `kind` | `"governance"` | |
| `governance` | `{ mode, path }` | The mode `steering/governance.toml` declares at the merge, and the file |
| `mergedCommit` | `string` | |
| `bundleVersion` | `{ before, after }` | Equal, because the merge appends no ledger entry |
| `publishedVersion` | `number` or `null` | As in the record arm |

A steering PR proposal answers the steering PR arm:

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `status` | `"merged"` | |
| `kind` | `revert`, `tools`, `import`, `memory_pr`, `agent_file`, `agent_proposal`, or `workspace` | |
| `pullRequest` | `{ number, branch }` | The PR that merged |
| `retired` | `string[]` | The lineages of the records a revert retired. Empty for every other merge |
| `mergedCommit` | `string` | |
| `bundleVersion` | `{ before, after }` | They differ by the number of retired records, one ledger entry each |
| `publishedVersion` | `number` or `null` | As in the record arm |

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `not_found` | `proposal_not_found` | |
| `conflict` | `already_merged` / `checks_not_passed` / `pr_not_recorded` / `governance_unreadable` / `head_moved` / `base_moved` / `record_file_missing` | `head_moved`: the branch moved after the checks ran; run `open_context_pr` again. `base_moved`: the PR was retargeted off the production branch; nothing merges. |
| `conflict` | `merge_in_progress` | Another call is landing this PR. Try again when it finishes, or after its claim lapses ten minutes after it started. |
| `conflict` | `github_refused` | GitHub refused the merge (a required review, a moved head); nothing is published. |
| `conflict` | `approvals_not_head_bound` | GitLab only. The project keeps approvals after a push, GitLab answered 403 or 404 when asked whether it does, or GitLab reported an approval with no `approved_at`. Nothing merges. Turn on "Reset approvals on push" (Settings > Merge requests > Approval settings). |
| `conflict` | `gitlab_refused` | GitLab only. GitLab refused a call, or has not yet recorded the head as a diff version of the merge request. Nothing merges. Merge again in a minute. |
| `forbidden` | `approval_required` | Outside `solo` mode no approval stands at the head that merges, and the merger is not an owner and does not hold `merge_pr_without_review`. Nothing merges. |
| `conflict` | `merge_time_unknown` | The merge landed on GitHub and GitHub did not say when, so the publication would have to guess the instant `latestPublication` orders by. Nothing is published, the proposal stays `checks_passed`, and the next call resumes the merge GitHub holds and publishes it. |
| `conflict` | `governance_invalid` / `governance_file_missing` / `checks_failed` / `layout_changed` | A governance proposal only. The file at the head is not governance/v1 or is gone, the steering checks failed, or the production branch no longer holds `steering/governance.toml`. Nothing merges. Set the mode again. |
| `conflict` | `checks_failed` / `steering_repo_required` / `merged_outside_oxagen` | A steering PR proposal only. The steering checks failed on the head, and the "Oxagen steering" check on the PR holds the report; the repository is not a steering repository; or someone merged the PR on the host. Nothing merges. |
| `forbidden` | `review_required` | A governance proposal only. No approval stands, and the merger would otherwise land it without review, or the call is `merge_pr_without_review`. Nothing merges. |
| `forbidden` | `no_principal` / `org_role_required` / `separation_of_duties` | `no_principal` before anything is read (an API key); the rest is the governance mode's reviewer rule. |
