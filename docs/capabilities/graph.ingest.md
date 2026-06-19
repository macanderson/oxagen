# graph.ingest

**Domain:** graph
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Turn raw text into knowledge-graph nodes and edges. `graph.ingest` is the
ingestion bridge from web-search / document text to the customer's ontology: it
reads the workspace graph prompt (and any provided type hints) to decide which
entity and edge types matter, runs LLM-driven entity + relationship extraction
with confidence — following the seeded `entity-extractor`,
`relationship-extractor`, and `graph-ingestion` skills' discipline of restraint
(only what the text states; no invented endpoints; edge types constrained to the
graph vocabulary) — and commits the results through `graph.node.upsert` /
`graph.edge.upsert`. The upsert is an idempotent MERGE, so it doubles as entity
resolution (a second mention of the same entity resolves to the existing node).

## Input

| Field | Type | Notes |
| --- | --- | --- |
| text | string | Source text to extract from (1–100,000 chars) |
| sourceUrl | string? | Provenance; stored on created nodes |
| entityTypeHints | string[]? | Entity types (node labels) to look for; defaults to the workspace graph prompt |
| maxEntities | number | Cap on entities to extract: 1–50 (default 25) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| entities | array of objects | Created/resolved nodes: nodeId, name, type, confidence, created |
| relationships | array of objects | Created/resolved edges: edgeId, from, to, edgeType, confidence, created |
| summary | string | Plain-language summary of what was ingested |

Only relationships whose **both** endpoints resolved to a node are committed —
the rest are dropped (no invented endpoints). Edge types are constrained to the
graph relationship vocabulary (`RELATED_TO`, `PART_OF`, `CAUSED_BY`,
`REFERENCES`, `SIMILAR_TO`, `DEPENDS_ON`, `CREATED_BY`, `MENTIONS`).

## Side effects

- One LLM extraction call through `@oxagen/ai`, metered to the org.
- One `graph.node.upsert` per entity and one `graph.edge.upsert` per resolved
  relationship — each independently gated and idempotent. Confidence is stored
  as a property on every created node and edge.

## Chaining

`graph.ingest` consumes `document.text` / `search.results` and produces
`graph.nodeId` / `graph.edgeId`, so the planner chains
`research.swarm.status → graph.ingest → graph.node.list` and the result renders
through the `graph-ingest-card` chat component (deep-linked nodes + confidence
labels).
