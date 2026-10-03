# Ingestion dedup

- **Status:** accepted
- **Snapshot:** 2026-10-03, `origin/main` plus the pull request that added this page (refs #4148 and #2974)
- **Related:** [ADR-194](../../adr/ADR-194-every-embedding-is-voyage-4-large-on-one-platform-key.md) (embeddings on Voyage, and ingestion keeps a record when they fail), [ADR-117](../../adr/ADR-117-bound-github-retries-and-use-managed-graph-transactions.md) (managed graph reads)

Every record a connector sends becomes one `:EntityNode` in the organisation's graph. Dedup decides whether the record is a node the graph already holds, an alias of one, or a new node. The code is `packages/ingestion/src/dedup/resolve.ts`, and the ingestion pipeline runs it as two steps (`packages/inngest-functions/src/functions/ingestion.pipeline.ts`).

## Pass A

Pass A looks up the record's natural key, a stable id the connector builds from the source record. A node with that key in the same organisation is the same entity, so the pipeline updates it. Pass A needs no embedding and no vector index.

## Pass B

Pass B runs only when Pass A finds nothing. It embeds the record's type, name, and simple properties, then asks the vector index `entity_node_embedding_index` for the closest nodes of the same organisation and type. Each candidate gets a combined score:

| Signal | Weight |
|---|---|
| Cosine similarity of the two vectors | 0.4 |
| Same email, or else the same URL | 0.4 |
| Similar display name | 0.2 |

A best score of 0.92 (`CONFIRM_THRESHOLD`) or more links the record to the candidate with a confirmed `ALIAS_OF` edge. A score from 0.70 (`ALIAS_THRESHOLD`) up to 0.92 links it with a tentative edge, which a person can review. Below 0.70 the record becomes a new principal, a node with no `ALIAS_OF` edge of its own.

## When Pass B cannot run

Pass B fails when the embedder refuses the key, is rate limited, or is down, and when the vector index refuses the query. A refusal from the embedder reaches dedup as `EmbeddingUnavailableError` after the SDK's retries.

**Decision: dedup degrades and never drops the record.** The record is written as its own principal with no vector, and the node is marked `similarityDeferredAt`. ADR-194 records this behaviour, and #2974 asked for it.

Why:

- **A lost record cannot come back.** Nothing replays an ingestion step once its retries are spent. When dedup did not degrade, an embedder outage failed the dedup step, so every record that arrived during the outage was gone. A gateway key that could not log in, and then a free-tier rate limit, each emptied a whole GitHub backfill this way.
- **A duplicate can be fixed later.** The mark says which nodes skipped Pass B, so a job can run it for them once the embedder is back.

The cost: until the reconcile job runs, a record may sit as its own principal where it should be an alias, and semantic search misses it until it has a vector.

A failed embedding in the pipeline's later embed step does not fail the run either. The node is already written, and only its vector is missing.

## Recovery

Two scheduled jobs repair what an outage left behind. Each runs one pass at a time.

1. **Embedding backfill** (`embeddings/backfill`, every 30 minutes, `packages/inngest-functions/src/functions/embeddings.backfill.ts`). It embeds every node whose `embedding` is null, so a deferred node gets its vector.
2. **Similarity reconcile** (`similarity/reconcile`, at 15 and 45 minutes past the hour, `packages/inngest-functions/src/functions/similarity.reconcile.ts`). It runs Pass B for each marked node, through `reconcileDeferredNode` in `packages/ingestion/src/dedup/reconcile.ts`.

The reconcile job works one workspace at a time, inside that workspace's tenant scope. For each marked node it does this:

| Node | What the job does | Mark |
|---|---|---|
| Has a vector, and a candidate scores 0.70 or more | Links the node to that candidate with `ALIAS_OF`, as ingestion does | Cleared |
| Has a vector, and no candidate scores 0.70 | Leaves the node as a principal | Cleared |
| Already has an `ALIAS_OF` edge | Adds no edge | Cleared |
| Has no vector yet | Nothing. The backfill embeds it first, unless its connection opted out of embedding | Kept |
| The vector index refuses the search | Nothing, and the next run tries again | Kept |

The search is ingestion's own Pass B (`findSimilarityMatch`), with two changes:

- It leaves the node itself out, because a node always matches its own vector.
- It keeps only principals. Two duplicates written during one outage would otherwise each find the other, and the job would link them in a loop.

Each run selects at most 500 marked nodes, and only nodes that have a vector, so nodes waiting for the backfill cannot fill the run. It reconciles them in steps of 25 nodes from one workspace. A retried step is safe: a reconciled node no longer carries the mark, a linked node gets no second edge, and `createAliasEdge` merges the edge it writes.

## Logs

- `[ingestion] dedup: embedding failed, deferring similarity match` names the embedder's error for one record.
- `ingestion-pipeline: embedding backend unavailable` says the record was written without Pass B and marked.
- `embeddings.backfill: run complete` gives `missingBefore` and `stillMissing`.
- `similarity.reconcile: run complete` gives `deferredBefore`, `withoutVector`, each outcome's count, and `stillDeferred`. `withoutVector` counts marked nodes still waiting for a vector. It includes nodes the backfill never embeds: a record type whose connection turned semantic inference off, and a node whose connection row is gone. Those keep the mark. `deferredBefore` minus `withoutVector` is the set Pass B has yet to reach.
