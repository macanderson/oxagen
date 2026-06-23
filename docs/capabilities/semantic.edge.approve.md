# semantic.edge.approve

> **Deprecated** — `semantic.edge.approve` is a one-release alias for [`semantic.relationship.approve`](semantic.relationship.approve.md), which will be the canonical name from v2 onward. Migrate now: the capability name is the only change; input, output, and API path are identical.

**Domain:** semantic
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium

## Intent

Approve or reject an inferred semantic edge candidate. Approved edges are
materialised as permanent :SEMANTIC_EDGE relationships in Neo4j; rejected edges
are soft-dismissed with an audit trail.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| edgeId | string | UUID of the InferredEdge node to act on |
| decision | enum | "approve" (materialise) or "reject" (dismiss) |
| comment | string? | Optional reviewer note for audit purposes (max 1000 chars) (optional) |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| edgeId | string | The InferredEdge id that was acted on |
| decision | enum | Decision from input: "approve" or "reject" |
| permanentEdgeId | string? | Neo4j relationship element id (present only when decision="approve") |

## Side effects

Neo4j updates: approved edges materialised as permanent :SEMANTIC_EDGE
relationships; rejected edges marked with audit trail. Postgres record updated.
ClickHouse telemetry.

## Errors

None explicitly defined in the contract.
