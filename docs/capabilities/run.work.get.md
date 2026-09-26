# get_run_work

Read the machine and checkout locations recorded for a run, captured patch references, connected pull requests with their CI checks, and the subagents the session started.

**Surfaces:** api

**Mode:** sync

**Input:** `{ runId: "tse_…" | "arun_…" }`

**API:** `POST /v1/:org_slug/:workspace_slug/runs/work`

This console read does not consume AI credits. IAM and the run reader enforce organization and workspace access. It remains available independently of the optional paid Run assistance feature.

`checkouts` preserves distinct recorded paths, branches, and repository digests. A machine or location that was not recorded stays absent. The daemon records a session's first hook before its first Git read, so that frame names a path and no branch, remote, or head. Such a path-only frame folds first into a Git context at the same path whose recorded frames span it, since the session came back to that context. When several do, it folds into the one that started last. Failing that, it folds into the context that starts next after it, when that is a Git context at the same path. Failing that too, it folds into the context that started last before it, when that is a Git context at the same path. A frame another context separates from every Git context at its path stays a path-only checkout. The read groups every path-only frame at a path into one location, so its first and last frames fold on their own, and neither stretches a checkout past the start of another. A captured diff on a location that folded whole names the checkout its first frame folded into. Two branches or two repositories at one path stay separate checkouts. A path-only location with no Git context at its path stays as it is. Historical repository digests can match repositories connected to this workspace. A recorded URL alone does not authorize a provider call.

`diffs` names reconciliation frames by sequence and content digest. Read retained JSON through `get_run_frame_body`; that reader verifies its digest. The JSON holds the observed root, baseline, head, patch, and limits. Exact bytes follow the existing tool-content retention policy and redaction path. A diff can include work that predates the run. It does not establish authorship. Missing capture, withheld bytes, partial capture, and retained content have separate states. A retained patch the recorder redacted reads `partial` with the `content_redacted` limitation, whatever the collector's own completeness flag said, because the seal removed bytes after the collector judged the snapshot.

`pullRequests` identifies its association as a recorded receipt, an exact head match, or a branch match. CI reads use the PR head SHA and page through checks and statuses, up to ten pages each. The handler rereads the PR head after collecting files. A moved head sets `current: false` and discards the mutable diff. Missing patches, file limits, and provider failures remain explicit. Each pull request names its `headRef` and its `baseRef`, the branch it merges into, as GitHub records them. The Run page's Changes panel prints `baseRef` as the run's base.

Each pull request carries `closingIssues`, read from GitHub's `closingIssuesReferences`: the issues a closing keyword or a sidebar link ties to it. A failed read returns `null` with the `closing_issues_read_failed` warning. A list longer than 25 returns `complete: false` with the `closing_issue_limit` warning. The Run page's Issues tab lists these issues only for pull requests with the `recorded` association, because a head or branch match does not show that the run opened the pull request.

`subagents` lists one entry per subagent the session started, keyed by the agent id on its `subagent_start` and `subagent_stop` hook frames. Each entry carries the agent type the frames recorded, the first and last sequence, and whether a stop frame arrived. A type the frames did not carry is null. Ledger runs return an empty list, because the ledger records no subagent frames. The read returns at most 200 subagents and warns with `subagent_limit` past that.

The read limits checkout groups and recorded diffs to 200 each, PRs and discovery requests to 20 each, and each PR patch response to 512 KiB. A collector snapshot holds at most 256 KiB and probes at most 32 untracked files. Limits do not turn missing evidence into an empty successful result.

Checkouts, captured diffs, subagents and pull request receipts come from every frame the control plane accepted from the run's host, including frames past a chain break. When the session's hash chain broke, the read returns `complete: false` with the `chain_break` warning rather than dropping those frames (ADR-171). A sealed run also names the break in its completeness gaps.

A wrapped run's `oxagen:pr_link` frames are its recorded receipts: each names `pr.number`, `pr.url`, and `pr.repository`, the attributes a `pr_open` call's effect frame carries. A frame sealed before #3944 names them `pr_number`, `pr_url`, and `pr_repository`, and the read accepts either spelling. Frames with the same URL count once. A receipt resolves only against a repository connected to this workspace that carries its provider repository id.

Ledger runs reuse recorded PR receipts. Their receipts do not record a host checkout, so location remains absent. The existing Outputs view retains file observations and ledger change locators.
