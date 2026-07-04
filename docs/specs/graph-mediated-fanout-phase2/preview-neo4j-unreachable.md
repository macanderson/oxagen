# CI defect: preview Neo4j unreachable — `migrate` job fails on any schema.cypher change

**Status:** needs ops action · **Found:** 2026-07-04 (PR #551 CI) · **Blast
radius:** the `migrate` job on every PR whose diff touches a Neo4j migration
source (`packages/ontology/src/schema.cypher`)

## Problem

The `migrate` job's "Migrate ClickHouse and Neo4j" step (`.github/workflows/
pipeline.yml:213-215`) runs against the **preview** stores on pull requests
(`PREVIEW_NEO4J_URI` et al). That connection currently fails DNS resolution:

```
Could not perform discovery. No routing servers available. …
Caused by: getaddrinfo ENOTFOUND ***.databases.***.io
```

The preview AuraDB instance either no longer exists or the
`PREVIEW_NEO4J_URI` secret points at a stale hostname. Postgres (Atlas) and
the per-store change detection work correctly — the step only fires when
schema.cypher actually changed, which is why most PRs never hit this.

## Evidence it predates PR #551

PR #357 (`feat(memory): two-axis memory model`, merged 2026-07-01) was the
previous change to schema.cypher; its CI run concluded `failure` with the
same job failing, and it was merged over the red check. No code change can
fix this — the step needs a reachable preview Neo4j.

## Required ops action

1. Restore (or recreate) the preview AuraDB instance, or repoint
   `PREVIEW_NEO4J_URI` / `PREVIEW_NEO4J_USERNAME` / `PREVIEW_NEO4J_PASSWORD` /
   `PREVIEW_NEO4J_DATABASE` GitHub secrets at a live instance.
2. Re-run the `migrate` job on the affected PR — the Cypher in
   schema.cypher is fully `IF NOT EXISTS`-idempotent, so replay is safe.

Until then, a red `migrate` job on a schema.cypher-touching PR is this
defect, not the PR.
