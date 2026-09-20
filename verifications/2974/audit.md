# Knowledge backlog audit

Base: `origin/main` at `0d03a96b9`. Branch: `fix/knowledge-backlog-reliability`.

This pass fixes the remaining request, transaction, and connector defects below. It references #2974 because the issue also requires external verification and deferred engram work.

| Issue | Current result |
| --- | --- |
| #2396 | Main now validates every row-selecting pattern and seam-owned tenant parameter. The older raw-word regex description is stale. Semantic graph isolation remains governed by ADR-087 and #3199. |
| #2406 | This change sends scoped queries through managed transactions. Reads use `executeRead`. Mutating clauses and procedure calls use `executeWrite`. The transaction callback contains only the query. Tenant parameters and transaction timeout survive retries. |
| #1825 | Engram rename or replay decision deferred under #3296, per the parent task. |
| #2824 | Main already retains records without vectors when embedding fails. `dedup/__tests__/resolve.test.ts` includes an embedding 429 regression. Paid capacity, model/index compatibility, and a live resync remain unverified. No credential or production mutation was attempted. |
| #2353 | This change adds a 30-second request deadline, caller cancellation, three total rate-limit attempts, server-directed waits, and a typed error when the required wait exceeds 120 seconds. Ambiguous network errors and non-rate-limit 403s are not retried. |
| #1271, #2398 | Main already checks UNION branches and avoids appending a write LIMIT, including #3522. |
| #1256, #1369, #1434, #1831 | Engram rows deferred under #3296. |
| #1265 | Still open. Peer review found that issue/PR numbers form natural keys without a repository qualifier. Expanding organization polling would make two repositories overwrite each other. Repository-qualified identity and migration/backfill handling must land before organization expansion or pagination changes. |
| #1267 | Calendar subscriptions now declare `event`, which the normalizer handles. |
| #1386 | Pattern compilation per value remains. This performance row is outside the transport and credential fixes. |
| #1875 | Custom-webhook still declares unused signature and JSONPath settings. This requires a separate connector configuration change. |
| #1253 | Main already carries HTTP status on GitHubApiError and branches on status 404. |
| #1254 | Main already walks directories when GitHub truncates a recursive tree. |
| #2356, #2357 | This change tests mint-failure fallback and envelope-key decryption. OAuth reads now bind orgId. The OAuth account schema is organization-scoped and has no workspaceId column. The source connection query already binds both organization and workspace. |
| #1464 | The unused DEGRADED_AFTER_FAILURES export remains. |
| #1465 | Do not delete enum members from the old row without fresh usage review. BackgroundTask and Plan now have schema constraints. |
| #1466 | Four unused temporal supersession helpers remain. |
| #1459 | No engram mutation attempted. The issue already records this row as not planned. |

## Verification

One local test file ran: `pnpm --filter @oxagen/github exec vitest run src/fetch-client.retries.test.ts`, 7 tests passed. Other added tests await CI. No coverage threshold changed. No full local suite, build, lint, or typecheck ran. Configured git hooks remain enabled.

The rate-limit policy follows [GitHub's REST rate-limit guidance](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api). Transaction callbacks follow the [Neo4j managed transaction guidance](https://neo4j.com/docs/javascript-manual/current/transactions/).
