# get_run_work

Read the machine and checkout locations recorded for a run, captured patch references, and connected pull requests with their CI checks.

**Surfaces:** api

**Mode:** sync

**Input:** `{ runId: "tse_…" | "arun_…" }`

**API:** `POST /v1/:org_slug/:workspace_slug/runs/work`

This console read does not consume AI credits. IAM and the run reader enforce organization and workspace access. It remains available independently of the optional paid Run assistance feature.

`checkouts` preserves distinct recorded paths, branches, and repository digests. A machine or location that was not recorded stays absent. Historical repository digests can match repositories connected to this workspace. A recorded URL alone does not authorize a provider call.

`diffs` names reconciliation frames by sequence and content digest. Read retained JSON through `get_run_frame_body`; that reader verifies its digest. The JSON holds the observed root, baseline, head, patch, and limits. Exact bytes follow the existing tool-content retention policy and redaction path. A diff can include work that predates the run. It does not establish authorship. Missing capture, withheld bytes, partial capture, and retained content have separate states.

`pullRequests` identifies its association as a recorded receipt, an exact head match, or a branch match. CI reads use the PR head SHA and page through checks and statuses, up to ten pages each. The handler rereads the PR head after collecting files. A moved head sets `current: false` and discards the mutable diff. Missing patches, file limits, and provider failures remain explicit.

Each pull request carries `closingIssues`, read from GitHub's `closingIssuesReferences`: the issues a closing keyword or a sidebar link ties to it. A failed read returns `null` with the `closing_issues_read_failed` warning. A list longer than 25 returns `complete: false` with the `closing_issue_limit` warning. The Run page's Issues tab lists these issues only for pull requests with the `recorded` association, because a head or branch match does not show that the run opened the pull request.

The read limits checkout groups and recorded diffs to 200 each, PRs and discovery requests to 20 each, and each PR patch response to 512 KiB. A collector snapshot holds at most 256 KiB and probes at most 32 untracked files. Limits do not turn missing evidence into an empty successful result.

Ledger runs reuse recorded PR receipts. Their receipts do not record a host checkout, so location remains absent. The existing Outputs view retains file observations and ledger change locators.
