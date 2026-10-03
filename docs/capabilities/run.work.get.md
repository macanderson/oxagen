# get_run_work

Read the machine and checkout locations recorded for a run, captured patch references, the run's pull requests from Oxagen's own store with their CI checks, and the subagents the session started.

**Surfaces:** api, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).

**Mode:** sync

**Input:** `{ runId: "tse_…" | "arun_…" }`

**API:** `POST /v1/:org_slug/:workspace_slug/runs/work`

This console read does not consume AI credits. IAM and the run reader enforce organization and workspace access. It remains available independently of the optional paid Run assistance feature.

`checkouts` preserves distinct recorded paths, branches, and repository digests. A machine or location that was not recorded stays absent. The daemon records a session's first hook before its first Git read, so that frame names a path and no branch, remote, or head. Such a path-only frame folds first into a Git context at the same path whose recorded frames span it, since the session came back to that context. When several do, it folds into the one that started last. Failing that, it folds into the context that starts next after it, when that is a Git context at the same path. Failing that too, it folds into the context that started last before it, when that is a Git context at the same path. A frame another context separates from every Git context at its path stays a path-only checkout. The read groups every path-only frame at a path into one location, so its first and last frames fold on their own, and neither stretches a checkout past the start of another. A captured diff on a location that folded whole names the checkout its first frame folded into. Two branches or two repositories at one path stay separate checkouts. A path-only location with no Git context at its path stays as it is. Historical repository digests can match repositories connected to this workspace. A recorded URL alone does not authorize a provider call.

`diffs` names reconciliation frames by sequence and content digest. Read retained JSON through `get_run_frame_body`; that reader verifies its digest. The JSON holds the observed root, baseline, head, patch, and limits. Exact bytes follow the existing tool-content retention policy and redaction path. A diff can include work that predates the run. It does not establish authorship. Missing capture, withheld bytes, partial capture, and retained content have separate states. A retained patch the recorder redacted reads `partial` with the `content_redacted` limitation, whatever the collector's own completeness flag said, because the seal removed bytes after the collector judged the snapshot.

`pullRequests` comes from the forge store (ADR-292), the same store `get_change_set` reads. No GitHub call finds a pull request. The list is the run's change set: its `forge.pull_request_runs` links, and its `tacho.run_pull_requests` rows matched to forge rows by provider, repository, and number. Three older sources add a pull request only when the store already holds it:

- a ledger run's `provider_publish` receipts, matched by GitHub repository id and number;
- a wrapped run's link frames, matched by repository path and number;
- a checkout's branch, matched to a pull request's head branch in the same repository.

A receipt or link frame that names a pull request the store lacks adds the `pull_request_not_stored` warning. The backfill (`forge/pull-request-backfill`) moves links recorded before the store existed into it.

Each pull request's `association` says how it was reached. `recorded` means the run's own link, a receipt, or a link frame named it. `head_commit` means only a checkout's branch reached it, and the checkout was on its head commit. `branch` means only a checkout's branch reached it. A checkout on a detached head names no branch. A checkout on a branch another stored pull request merges into, such as `main`, matches nothing, because work opened from a fork's `main` has `main` as its head. Both add the `default_branch_not_linked` warning.

The number, URL, title, state, head commit, `headRef`, and `baseRef` come from the forge row. The Run page's Changes panel prints `baseRef` as the run's base. `observedAt` is when the forge last reported the pull request.

`diff` comes from the pull request's latest revision. Its `files` are the revision's file list, and each file's `patch` comes from the stored diff, whose sha256 is checked against the one the revision recorded before any patch is answered. `digest` is that sha256 as `sha256:<hex>`. A file's `additions` and `deletions` are null when the forge listed it without line counts, as a GitLab compare can. Each pull request carries at most 512 KiB of patch text. A stored diff over 2 MiB, or past the read's 8 MiB total, answers its file list with no patches and the `diff_size_limit` limitation. A revision whose bytes are not kept answers its file list with no patches and the limitation `diff_too_large`, `diff_unreadable`, or `diff_unconfigured`. Stored bytes that are missing, that fail the digest check, or that this deployment names no store for keep the file list, name the reason as a limitation, and add the `diff_read_failed` warning. A pull request with no revision yet has `diff: null` and the `pull_request_revision_missing` warning. When the latest revision is for an earlier head, `diff.headSha` names that head, `current` is false, and the read warns `pull_request_head_not_captured`.

`ci` is the one live GitHub read, because the forge store holds no checks. It runs only for the pull requests this list names, at each one's stored head, through the workspace's connection for the repository. CI reads page through checks and statuses, up to ten pages each. A pull request in a repository the workspace does not connect has `ci: null` and the `repository_not_connected` warning. A GitLab merge request has `ci: null` and the `gitlab_checks_not_read` warning, and its repository reads `connected: false`, because the workspace's repository list names GitHub repositories only. A failed read returns `ci_read_failed`, and checks GitHub answers for another head set `current: false` with `ci_head_mismatch`.

Each pull request carries `closingIssues` from the forge store's issue links, which the sync reads from GitHub's closing references at each new head. It is null for a GitLab merge request, whose closing references are not read, and for a pull request with no revision yet, whose links were never read. The Run page's Issues tab lists these issues only for pull requests with the `recorded` association, because a head or branch match does not show that the run opened the pull request.

`subagents` lists one entry per subagent the session started, keyed by the agent id on its `subagent_start` and `subagent_stop` hook frames. Each entry carries the agent type the frames recorded, the first and last sequence, and whether a stop frame arrived. A type the frames did not carry is null. Ledger runs return an empty list, because the ledger records no subagent frames. The read returns at most 200 subagents and warns with `subagent_limit` past that.

`releases` lists the releases the session created (#3890, ADR-197), one per repository and tag, at the first command frame that created it, in frame order, at most 20 (`release_limit` past that). A release is a `gh release create <tag>` in a command frame's command head, or the `release.repository` and `release.tag` attrs the recorder writes on a GitHub MCP release call's frame. Each names its repository, its tag, and the frame, and carries the release's name, URL and state as GitHub reads it now: `draft`, `prerelease`, or `published`. The repository is the one the command names (`-R`, `--repo` or `GH_REPO`), else the one recorded for the checkout the frame ran in, else the run's only recorded repository. A release whose repository none of these names is left out with the `release_repository_unknown` warning.

The state is read when the page loads, from the repository's first 100 releases through the workspace's connection for it, one read per repository. A state is null when:

- the repository has no connection in this workspace (`recorded_repository_not_connected`);
- GitHub has no release with the tag (`release_not_found`);
- the tag is not among the first 100 releases (`release_list_limit`);
- GitHub could not be read (`release_read_failed`).

The frame read stops at 2,000 frames with the `release_frame_limit` warning. Ledger runs return an empty list, because the ledger records no shell commands.

The read limits checkout groups and recorded diffs to 200 each, and pull requests to 20 (`pull_request_limit` past that). A collector snapshot holds at most 256 KiB and probes at most 32 untracked files. Limits do not turn missing evidence into an empty successful result.

Checkouts, captured diffs, subagents and pull request receipts come from every frame the control plane accepted from the run's host, including frames past a chain break. When the session's hash chain broke, the read returns `complete: false` with the `chain_break` warning rather than dropping those frames (ADR-171). A sealed run also names the break in its completeness gaps.

A wrapped run's `oxagen:pr_link` frames are its recorded receipts: each names `pr.number`, `pr.url`, and `pr.repository`, the attributes a `pr_open` call's effect frame carries. A frame sealed before #3944 names them `pr_number`, `pr_url`, and `pr_repository`, and the read accepts either spelling. Frames with the same URL count once. A link frame is looked up in the forge store whether or not the workspace connects its repository.

Ledger runs reuse recorded PR receipts. Their receipts do not record a host checkout, so location remains absent. The existing Outputs view retains file observations and ledger change locators.
