# Data retention

Your retention review needs the deletion mechanism beside the period. These are source settings at the [pack baseline](README.md), not a confirmation that each scheduled job has run in production.

| Data class | Configured period or policy | Mechanism and limit |
| --- | --- | --- |
| Postgres security events | Seven calendar years | Daily 03:00 UTC [partition maintenance](../../packages/inngest-functions/src/functions/security.audit-partition-rollover.ts), specified by [ADR-125](../adr/ADR-125-audit-partition-maintenance-and-telemetry-boundaries.md). Named partitions expire by upper bound. DEFAULT cleanup is bounded, so a backlog can remain. |
| Hot ledger frame rows | Thirteen months after sealing | Monthly [frame compaction](../../packages/inngest-functions/src/functions/evidence.frame-compaction.ts). Archive segments retain the evidence. Compaction is not deletion of the archived content. |
| Frame bodies and exported archives | Seven-year policy default | [ADR-058](../adr/ADR-058-run-record-placement-retention-default-and-digest-only.md) names the policy. A corresponding timed blob-deletion job is not established by this pack. `digest_only` changes capture, not deletion of previously captured objects. |
| ClickHouse IAM audit | Seven years | Table TTL in [0003](../../packages/telemetry/src/migrations/0003_iam_audit.sql). TTL processing is asynchronous. |
| ClickHouse usage events | One year | Table TTL in [0019](../../packages/telemetry/src/migrations/0019_usage_events.sql). |
| Durable token usage | 365 days | Table TTL in [0029](../../packages/telemetry/src/migrations/0029_durable_token_usage.sql). |
| Error events | 90 days | Table TTL in [0020](../../packages/telemetry/src/migrations/0020_error_events.sql). |
| Claude telemetry and run summaries | One year and two years respectively | TTLs in [0006](../../packages/telemetry/src/migrations/0006_claude_telemetry.sql) and [0007](../../packages/telemetry/src/migrations/0007_claude_sessions.sql). The older erasure processor comment saying these have no TTL is stale. TTL is not subject-specific erasure. |
| Wrapped-run events | No timed deletion established here | [0027](../../packages/telemetry/src/migrations/0027_tacho_events.sql). Do not apply another telemetry table's TTL by analogy. |
| Expired credential grants | 90 days after expiry or revocation | Weekly [grant retention](../../packages/inngest-functions/src/functions/mcp.credential-grant-retention.ts). |
| Deleted-server tool snapshots | 365 days after server deletion | Monthly [snapshot retention](../../packages/inngest-functions/src/functions/mcp.tool-snapshot-retention.ts). |
| Authentication cookies | 30-day expiry, one-day refresh interval | [Auth configuration](../../packages/auth/src/auth.ts). Expiry of a cookie is not an account-deletion policy. |
| Application logs | 30 days searchable, archived for 5,110 days | [CloudWatch and S3 lifecycle](../../infra/stacks-new/oxagen/observability.tf). Archives transition storage class before expiration. This is longer than seven years. |
| Aurora backups | 35 days | [Cluster configuration](../../infra/stacks-new/oxagen/data-services.tf). Final snapshots have a separate lifecycle. |
| Neo4j volume snapshots | Hourly, seven-day module default | [DLM policy](../../infra/modules/app-node/backup.tf), [variables](../../infra/modules/app-node/variables.tf). Verify stack overrides and actual snapshots. |
| Accounts, billing records, graph nodes, other blobs | No single automatic expiry policy established here | Inspect the relevant schema and [privacy processor](../../packages/inngest-functions/src/functions/privacy.erasure.execute.ts). Do not promise full deletion on request. |

## Requests and verification

[Export](../../packages/handlers/src/privacy.data.export.ts) and [erasure](../../packages/handlers/src/privacy.data.erase.ts) record requests. The [erasure processor](../../packages/inngest-functions/src/functions/privacy.erasure.execute.ts) cleans a limited identity subset, then reports failure because the full multi-store cascade is incomplete. [The SOP](../specs/gdpr/sop-data-erasure.md) describes operations but does not supersede this implementation limit.

For a retention review, capture the deployed migration version, the table's actual TTL or partition boundaries, and the last successful scheduled job. Verify object deletion separately from row compaction. Record exceptions and backup expiry before certifying completion of an erasure request.
