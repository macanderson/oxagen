# run.evidence.list

**Domain:** run
**Mode:** sync
**Scope:** tenant (org + workspace)
**Requires approval:** no
**Risk level:** low

## Intent

Read-only listing of **RunEvidenceManifestV1** summaries for the workspace,
newest first, with keyset pagination on `created_at`. Backs the evidence-ledger
read surface: which governed attempts have attested evidence, under what
authority, with how many changed files and context frames. Pairs with
[run.evidence.submit](run.evidence.submit.md).

Postgres-only: change/frame counts are derived from the child tables, never from
ClickHouse.

## Input

| Field          | Type                          | Default | Notes                                                         |
| -------------- | ----------------------------- | ------- | ------------------------------------------------------------- |
| `runId`        | `string` (opt.)               | —       | Filter to one run's manifests.                                |
| `repositoryId` | `string` (uuid, opt.)         | —       | Filter to manifests whose checkout was of this repository.    |
| `limit`        | `integer` (1 – 100)           | `25`    | Max manifests to return.                                      |
| `cursor`       | `string` (ISO datetime, opt.) | —       | Keyset cursor: manifests created strictly before this time.   |

## Output

| Field        | Type              | Notes                                                                    |
| ------------ | ----------------- | ------------------------------------------------------------------------ |
| `manifests`  | `Manifest[]`      | Newest first. Each carries `id`, `runId`, `attemptId`, `evidenceAuthority`, `manifestDigest`, `createdAt`, `changeCount`, `frameCount`. |
| `nextCursor` | `string \| null`  | Pass as `cursor` to fetch the next page; `null` when no more rows.        |

## Pagination

Keyset (not offset): the handler over-fetches one row to compute `nextCursor`,
so deep pages stay cheap and stable under concurrent inserts.

## Side effects

None — read-only.

## Errors

| code        | meaning                                            |
| ----------- | -------------------------------------------------- |
| `forbidden` | Caller lacks read permission on the run domain.    |

## Surfaces

- **API:** `GET /v1/{org}/{ws}/run/evidence?runId=&repositoryId=&limit=&cursor=`
- **MCP:** tool `list_run_evidence`
- **CLI:** `oxagen run evidence list [--run-id <id>] [--repository-id <uuid>]`
