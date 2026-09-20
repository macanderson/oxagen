# Historical merge audit for #3485

This pass reconstructs actual PR merge bases and branch integration commits. It corrects ADR-110's explanation of the known CLI-session regression. It does not establish that every candidate is free of a live defect.

## Frozen scope

The worktree started at freshly fetched `origin/main`, `ec637f8e4bf21de30776fad2a54dde6ff6d6b78d`. That commit included the accidentally pushed RLS change. Before any edits, the worktree integrated the recovery branch at `2174aa7f74cfa214db2e04c5d0e8ca3335f09db3`. All current-state comparisons use that recovery tip. No production state was changed.

[prs.json](prs.json) contains 161 PRs merged into `main` from 2026-09-17 through the frozen tip. Every recorded merge is an ancestor of that tip, and every retained PR head was fetched and matched its recorded SHA. The query, counts, and raw-output SHA-256 are in [summary.json](summary.json).

The scan produced **442 baselines: 161 final squashes and 281 distinct branch integrations**. It produced **588 candidate file/baseline pairs**, all from branch integrations. A candidate means an exact line added by the incoming main history is absent from the integration result, or a line that history removed has returned. Binary changes are retained for separate review. These counts describe signals, not defects.

## Reproduce

Run from the repository root with the recorded Git objects available:

```bash
node tools/scripts/audit-stale-squash.mjs docs/reviews/stale-squash-3485/prs.json 2174aa7f74cfa214db2e04c5d0e8ca3335f09db3 /tmp/squash-3485
```

The command writes `/tmp/squash-3485-baselines.json` and `/tmp/squash-3485-candidates.json`. [baselines.json](baselines.json) retains the first output. [candidates.json.gz](candidates.json.gz) retains the complete second output, compressed without a timestamp. Decompress it with `gzip -dc` and compare its SHA-256 with `summary.json`.

If a PR head is missing, fetch `refs/pull/<number>/head` from `origin` into a local audit ref and check it against `headRefOid`. A missing object, failed Git read, or multiple merge bases stops the collector. The collector uses no network API itself.

For each PR, the collector compares the squash result with the pre-squash main tip using their actual branch merge base. It also walks the retained PR head's first-parent integration history. Each secondary parent that is an ancestor of pre-squash main supplies an incoming-main baseline. It deduplicates a shared integration across PRs. This catches an earlier fix even when unrelated main commits intervened, and catches the known loss after the branch already integrated the fix.

## Confirmed incident

[incident.json](incident.json) preserves #3178's parent IDs and the relevant file diffs. Integration `d98301fa11af02d8848ec20aa95ae105ee4d1d43` has fix commit `e42e997e61b44a2c0d67661ad14c381ca9d63f0c` as its second parent, but discards its CLI exemption. The subsequent squash does not change those IAM files relative to the integration result. The frozen tip has the restored exemption with the stronger required-person condition.

This disproves the original claim that an untouched old copy generally wins a clean squash. Requiring the branch to contain the fix commit would not have caught this particular integration error. The new Git fixture tests prove both the bad-integration case and a clean squash that preserves a main-only fix.

## Reviewed signals

An independent read-only audit reviewed **87 candidate records** involving #3183, #3178, #3171, #3169, #3156, and #3154. [reviewed-87.json](reviewed-87.json) identifies every record and its evidence group. It found no confirmed live behavior loss within those records. Examples include the shared client-IP extraction, explicit local rate-limit degradation, enrollment credential retirement, the restored CLI exemption, and paginated CLI listing.

Additional source inspection found these apparent losses to be replacements:

- The recorder's rollback wrapper became `computeStandardUpdate` followed by validation and `commitStandardUpdate`. The refused-record regressions remain in `otel.test.ts`.
- The parity check's `alsoGaps` block became `alsoGap`, which still checks secondary bindings and feeds forward gaps.
- The sealed transcript cursor check now runs against the existing cursor before creating another cursor. Tombstones remain until the registry forgets the session.
- The shipper's earlier 8 MiB estimate became the shared 4 MiB request cap, encoded-request budgeting, and explicit 413 handling. Recursive shipping still waits for the left batch before advancing to the right.
- Repository rebinding still checks the current data plane and compares the recorded connection, owner, name, full name, and configured ref before writing a successor.
- The Cursor integration contains rewritten native hook translation and configuration code. The older exact lines are not evidence that Cursor support disappeared.

These extra examples do not convert the remaining 501 records into reviewed dispositions.

## Limits and remaining work

The collector is a bounded candidate detector. It does not prove semantic equivalence. Exact-line sets miss changed multiplicity, ordering, and behavior whose loss leaves the same lines elsewhere. Renames appear as deletion and addition candidates. Binary changes need separate inspection. First-parent traversal excludes integrations reachable only through merged side branches. Direct non-PR commits are outside the PR metadata scope.

The 501 records without an independent disposition remain to be reviewed or explicitly scoped by a maintainer. This report makes no blanket claim that the frozen tip has no live merge regression. #3485's issue-update requirement also remains with the coordinating maintainer. This PR references the issue and does not close it.

The old audit's 19-hit total cannot be reconstructed from its prose. Its six categories total 21, and neither the raw rows nor a frozen endpoint was retained. An explicit first-parent log through #3482 from midnight UTC on 2026-09-17 returns 119 commits, rather than the claimed 87. That difference cannot identify the original cutoff or duplicate rows. ADR-110 withdraws those counts instead of inventing a reconciliation.

## Verification

Only `tools/scripts/audit-stale-squash.test.ts` ran locally. Its Git fixtures cover non-adjacent loss, a damaged integration with a current final merge base, a clean squash preserving a main-only fix, deletion handling, missing-head refusal, and restored removed content. The same file covers the live advisory's previously omitted branch deletion. The full historical collector completed with the counts above. Suites, coverage, lint, and build remain CI checks.
