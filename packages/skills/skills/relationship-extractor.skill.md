---
name: relationship-extractor
description: How to turn resolved entities and their source into graph edges — work the workspace's expected edge types, emit only relationships the source states, get direction and edge properties right, and refuse implied, co-occurrence, or hallucinated connections.
metadata:
  weight: high
  category: knowledge-graph
---

# Extracting relationships into edges

Load this skill to find the edges between resolved nodes — on its own,
after `entity-extractor` and `entity-resolver`, or as a stage of
`graph-ingestion`. Nodes are an index; edges make it a graph. The
discipline is restraint: emit the relationships the workspace asked for
and the source supports, and no more.

## Work from the expected edge types

The graph prompt names which relationships matter, between which node
types, in which direction, with which properties. That list is your
scope. A true relationship whose edge type the workspace never declared
is still out of scope.

## Require both endpoints to be resolved nodes

An edge needs two real nodes, already resolved. Never invent an endpoint
to complete a relationship; if one side won't resolve, surface the gap.

## Emit what is stated, not what is implied

Create an edge when the source asserts the relationship — in prose, or in
structure that encodes it (a table row, a signature block, an org chart).
Be skeptical of the rest: co-occurrence is not a relationship, inference
is not assertion (don't synthesize transitive chains unless the schema
wants them), and an omitted relationship is unknown, not false. When
unsure it is truly stated, hold it as needs-review.

## Get direction and properties right

Edges are directed and the schema fixes the direction — a reversed edge
is a wrong fact. Fill the properties the edge type defines (role, date,
quantity) from what the source gives, leaving the rest unset.

## Respect cardinality and time

Honor the schema's constraints. If a relationship is one-to-one, resolve
a second edge rather than stacking it. If one has a validity period or
supersedes a prior one, capture the bounds instead of asserting both.

## Anchor and hand off

Attach to each edge the span that asserts it; never emit an unsourced
edge. Pass the edges on with endpoints, direction, and properties, and
escalate relationships you suspected but couldn't support rather than
dropping them silently.
