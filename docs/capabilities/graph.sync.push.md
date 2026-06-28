# graph.sync.push

Batch-upsert a content-addressed code or lineage subgraph into the workspace knowledge graph. All nodes are written as `is_system = true`, keyed by a stable content-addressed `key`. Re-sending the same envelope with the same `idempotencyKey` is a no-op — every MERGE is keyed so a re-push produces no database change.

Powers `oxagen graph push` (CLI code-delta up-sync, ADR-018 slice 2). Also the intended transport for execution lineage (ADR-018 slice 3).

## Mode
**sync**

## Surfaces
- API: `POST /v1/{org}/{workspace}/graph/sync/push`
- MCP: `graph.sync.push`
- CLI: `oxagen graph push` (uses this capability)

## Input

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `source` | `"code"` \| `"lineage"` | yes | Data source — `code` for repo structure; `lineage` for execution traces. |
| `idempotencyKey` | string (max 500) | yes | Content-addressed envelope key (e.g. `code:{repo}:{fromSHA}:{toSHA}`). Re-sending the same key is a no-op. |
| `nodes` | object[] | yes | Nodes to upsert. May be empty (e.g. edges-only or tombstone-only push). |
| `nodes[].key` | string | yes | Stable content-addressed key, e.g. `code:{repo}:{path}` (file) or `code:{repo}:{path}#{symbol}:{kind}` (symbol). Becomes the `naturalKey` in Neo4j. |
| `nodes[].labels` | string[] | yes | Domain labels (e.g. `["SourceFile"]`, `["Symbol"]`). The `:GraphNode` anchor is implicit. |
| `nodes[].displayName` | string | yes | Human-readable name (filename, symbol name, etc.). |
| `nodes[].properties` | object | yes | Arbitrary key-value metadata (path, language, signature, etc.). |
| `nodes[].isSystem` | `true` (literal) | yes | Always `true` — synced nodes are product-owned. |
| `edges` | object[] | yes | Edges to upsert between nodes by key. Both endpoints must exist in this push or already in the graph. |
| `edges[].sourceKey` | string | yes | Content-addressed key of the source node. |
| `edges[].targetKey` | string | yes | Content-addressed key of the target node. |
| `edges[].type` | string | yes | Relationship type — must match `[A-Z][A-Z0-9_]{0,62}` (e.g. `IMPORTS`, `CONTAINS`, `CALLS`). |
| `edges[].properties` | object | no | Optional edge metadata. |
| `edges[].inferred` | boolean | no | True for semantically inferred edges. |
| `tombstones` | object[] | no | Nodes to DETACH DELETE by key. Used when a file is removed from git. |
| `tombstones[].key` | string | yes | Key of the node to remove. |

## Output

| Field | Type | Description |
|-------|------|-------------|
| `nodesUpserted` | integer | Total nodes written (created or updated). |
| `edgesUpserted` | integer | Total edges written (created or updated). |
| `tombstoned` | integer | Total nodes removed via DETACH DELETE. |

## Idempotency model

Every node MERGE is keyed on `{naturalKey, orgId, workspaceId}` where `naturalKey = sync:{source}:{key}`. Re-sending the same `key` for the same org/workspace is a Cypher MERGE → no-op. The `idempotencyKey` field documents the envelope's intent for observability (it is not enforced at the DB level, but the MERGE operations are idempotent by construction).

## Tenant isolation

Every Cypher MERGE filters on BOTH `orgId` AND `workspaceId`. Cross-workspace collision is impossible: two workspaces in the same org with the same `key` produce separate Neo4j nodes with different `workspaceId` properties.

## Storage boundary (ADR-018)

- Code/lineage subgraph → **Neo4j** (`is_system = true`).
- Local git SHA cursor for delta computation → **DuckDB** (CLI, `code_push_cursor` table in `~/.config/oxagen/graph/{workspaceSlug}.duckdb`).
- No GitHub App or webhook required — the CLI uses `git diff` natively (vendor-neutral).

## CLI usage

```bash
# Push all tracked source files (first run or full reset)
oxagen graph push --full

# Incremental push — only files changed since last push
oxagen graph push

# JSON summary
oxagen graph push --json

# Override repo identifier
oxagen graph push --repo https://github.com/org/repo.git
```

## Related

- `graph.export` — down-sync; paginated workspace subgraph download for the local DuckDB replica.
- ADR-018: CLI ↔ Workspace Graph Bidirectional Sync.
