---
name: graph-ingestion
description: How to drive a document or batch of sources through the full graph-building pipeline — extract, resolve, relate, commit — idempotently, so re-ingesting a source updates the graph instead of duplicating it, resolving entities across the whole batch and escalating uncertain cases.
metadata:
  weight: high
  category: knowledge-graph
---

# Ingesting sources into the graph

Load this skill to own the whole pipeline rather than a single stage —
taking a document or a batch from raw source to committed graph. It
sequences `entity-extractor`, `entity-resolver`, and
`relationship-extractor`, then commits their output, and it owns what no
single stage sees: batching, ordering, idempotency, failure, and the
review queue.

## Load the graph prompt once and share it

Every stage reasons against the same node types, schemas, and expected
edges. Load the graph prompt once and pass it to each stage rather than
reloading per document.

## Sequence the stages

Run extract → resolve → relate → commit. Resolution must finish before
relationship extraction so edges bind to canonical nodes, not duplicates.
Commit last, after the source's whole subgraph is assembled, so a
mid-pipeline failure writes nothing partial.

## Resolve across the whole batch

The duplicate the resolver prevents within a document also appears
between documents — two sources introducing the same new entity. Treat
the batch as one resolution scope so they become one node, not two.

## Make ingestion idempotent

Re-ingesting a source must update the graph, not duplicate it. Key writes
on stable identifiers plus provenance so a second run recognizes and
updates what it already wrote. Re-runs are normal — retries, corrections,
overlapping batches — so design for them.

## Commit transactionally, fail safely

Group a source's writes so they land all-or-nothing where the store
allows. On partial failure, roll back or mark the source for safe replay
rather than leaving a half-built subgraph the next run can't tell from a
complete one.

## Escalate the uncertain, keep moving

Needs-review items from any stage go to a queue — not into the graph, not
into the bin. Don't block the batch on one doubtful node, and don't
auto-commit it to keep moving.

## Record what happened

Emit a per-source record: nodes created and matched, edges written, items
escalated, anything dropped and why. Ingestion you can't audit you can't
trust or resume.
