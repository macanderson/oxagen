# semantic.edge.approve

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
| observedAt | string? (ISO-8601) | Valid time of the fact (its event time); omit to stamp `validFrom = now` |
| supersede | boolean? | Close any other currently-open edge of the same type from the source (preserving history) so only this fact reads as valid. Default false. |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| edgeId | string | The InferredEdge id that was acted on |
| decision | enum | Decision from input: "approve" or "reject" |
| permanentEdgeId | string? | Neo4j relationship element id (present only when decision="approve") |
| superseded | number | Count of prior open edges of the same type from the source closed by supersession |

The materialised relationship carries bi-temporal validity (`validFrom`/`validTo` + `recordedAt`/`invalidatedAt`); `semantic.edge.list` and the time-aware ontology reads surface it.

## Side effects

Neo4j updates: approved edges materialised as permanent :SEMANTIC_EDGE
relationships; rejected edges marked with audit trail. Postgres record updated.
ClickHouse telemetry.

## Errors

None explicitly defined in the contract.
