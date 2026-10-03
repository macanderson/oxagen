# get_revision_diff

**Name:** `get_revision_diff`
**Domain:** run
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Agent:** Stella finds it with `search_tools` and loads it with `load_tools`. It runs with no approval step (`riskLevel: low`).
**Risk level:** low
**Billing:** `noBillingGate: true`
**Mutates:** no

## Intent

One pull request revision's diff from Oxagen's own store, split into files ([ADR-292](../adr/ADR-292-every-pull-request-read-comes-from-the-forge-store.md)). The bytes are checked against the sha256 recorded when they were captured before any is answered.

## Input

`{ revisionId: prv_…, paths?: string[] }`. `paths` reads only those files, at most 100.

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `revisionId` / `pullRequestId` | `prv_…` / `fpr_…` | |
| `headSha` / `mergeBaseSha` | `string` / `string \| null` | The diff runs from the merge base to the head |
| `diffStatus` | `stored \| too_large \| unreadable \| unconfigured` | Only `stored` carries hunks |
| `complete` / `limitations` | `boolean` / `string[]` | Why a stored diff is not complete, such as `files_truncated` |
| `diffSha256` | `string \| null` | The digest the stored bytes matched |
| `files[]` | `{ path, previousPath?, status, additions, deletions, patch, binary, truncated }` | `patch` is the file's hunks from its first `@@` line, at most 400,000 characters. It is null for a binary file, a revision without bytes, or a file past the answer's total |
| `truncated` | `boolean` | The answer's total of 2,000,000 characters left later files without hunks; read them with `paths` |

## Semantics

A revision whose bytes are not kept answers its file list with no hunks, and `diffStatus` says why: `too_large` when the forge refused the diff or it was over the capture cap, `unreadable` when the workspace's connection could not read it, and `unconfigured` when the deployment kept no diffs then. Whether a deployment keeps diffs depends on [`PR_DIFF_BUCKET`](../../packages/config/src/registry.ts).

## Errors

| code | reason |
| --- | --- |
| `not_found` | `revision_not_found` |
| `not_found` | `diff_missing`: the revision names bytes the store does not hold |
| `conflict` | `diff_digest_mismatch`: the stored bytes do not match the recorded digest |
| `conflict` | `diff_store_unconfigured`: the revision names stored bytes and this deployment names no store |
