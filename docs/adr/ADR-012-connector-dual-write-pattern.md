# ADR-012 — Connector dual-write pattern: Postgres (durability) + Neo4j (index)

**Date:** 2026-06-09
**Status:** Accepted
**Epic:** Knowledge Graph & Ingestion

## Context

Data connectors (GitHub, Linear, Salesforce, etc.) pull live data into the knowledge graph via a universal 5-stage pipeline. The cursor (sync position) and entity nodes (documents, issues, etc.) must be durably stored and queryable. Two viable strategies:

1. **Single-write with event sourcing**: ClickHouse = source of truth for all ingestion events. Postgres and Neo4j are derived views.
2. **Dual-write**: Postgres stores operational state (cursor, health). Neo4j stores the indexed graph. Both kept in sync.

CLAUDE.md infrastructure boundaries say "never write to two places" — but that rule assumes duplicated transactional data. Clarify whether the pattern is allowed and under what conditions.

## Decision

**Approve dual-write for connectors.** Use Postgres for operational durability, Neo4j for query indexing. They serve fundamentally different purposes and do not duplicate data.

### Write pattern

```
connector webhook/poll
    │
    ▼
ingest → validate → deduplicate → enrich → embed + commit
    │
    ├─→ Postgres (ACID): sync cursor, connection health, event log
    │   (source of truth for cursor; never lose it)
    │
    ├─→ Neo4j (async Inngest): entities + embeddings + relationships
    │   (index; retryable, lossy-okay; recoverable from Postgres cursor)
    │
    └─→ ClickHouse: observability events
        (telemetry: ingestion rate, latency, error rate)
```

### Why not single-write?

Event sourcing (ClickHouse = source of truth) introduces two problems:

1. **Cursor recovery**: To resume from a sync gap, we must reconstruct cursor state by replaying events from ClickHouse. That's expensive and adds latency to error recovery.
2. **Distributed consistency**: Postgres (cursor) and ClickHouse (events) are in separate transactions. A failure between them loses either the cursor or the visibility of what was synced.

Postgres as the operational record gives us atomic cursor updates and instant recovery.

## Alternatives considered

- **ClickHouse as single source of truth for all ingestion state.** Simpler conceptually, but event replay for cursor recovery is slow and error-prone. Violates the principle that Postgres is the operational lock.
- **Only write to Neo4j; derive cursor from entity timestamps.** Cursor becomes implicit and hard to recover precisely (off-by-one risks). Not suitable for production.

## Consequences

- OXA-1633 (Data Source Connectors epic) proceeds with dual-write as designed.
- All 40+ connectors follow the 5-stage pipeline: ingest → validate → deduplicate → enrich → embed + commit.
- **Postgres is the operational lock**: cursor must never be lost. ACID writes, recovery guarantee.
- **Neo4j is the index**: entities, embeddings, relationships. Async Inngest writes, retryable. If Neo4j write fails, the Postgres cursor is NOT advanced — the event is retried.
- **ClickHouse is observability**: ingestion event telemetry (rate, latency, errors) for monitoring and debugging.
- Clarification in CLAUDE.md: the infrastructure boundary rule ("never write to two places") does NOT forbid dual-write when stores serve different purposes (durability vs. indexing).

### Recovery guarantees

- **Cursor loss**: Not possible. Postgres ACID write is atomic; failure happens before the write or after. The event is either retried or skipped.
- **Stale Neo4j nodes**: Possible if Inngest write fails. But the cursor in Postgres is source of truth — the node can be re-upserted on retry.
- **Orphaned Neo4j nodes**: If a connection is deleted, a graph cleanup job is queued (async Inngest) to remove nodes tagged with `connection_id`. If the cleanup fails, nodes remain but sync is stopped (safe state).

## References

- OXA-1633: Data Source Connectors — Live Data Into the Context Graph
- CLAUDE.md: Infrastructure boundaries (updated 2026-06-09 with dual-write exception)
- OXA-1376: Universal 5-stage ingestion pipeline
