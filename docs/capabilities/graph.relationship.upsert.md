# graph.relationship.upsert

> **Replaces `graph.edge.upsert`** — `graph.edge.upsert` is a one-release alias that will be removed in v2. Migrate to `graph.relationship.upsert`. Key changes: `edgeType` → `relationshipType` (now open-vocabulary, not a fixed enum); `edgeId` → `relationshipId` in the output.

MERGE a typed relationship between two KnowledgeNodes. Relationship type must match the `RELATIONSHIP_TYPE_PATTERN` lexical guard (`/^[A-Z][A-Z0-9_]{0,62}$/`) to prevent Cypher injection.

## Mode
**sync**

## Surfaces
- API: `PUT /v1/graph/relationships`
- MCP: `graph.relationship.upsert`
- Agent: callable (no approval required, risk: low)
- CLI: available

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `fromNodeId` | string | yes | `publicId` of the source KnowledgeNode |
| `toNodeId` | string | yes | `publicId` of the target KnowledgeNode |
| `relationshipType` | string | yes | Relationship type name — must match `[A-Z][A-Z0-9_]{0,62}` (open vocabulary, not a fixed enum) |
| `properties` | record<string, string> | no | Optional string key-value metadata for the relationship |
| `observedAt` | string (ISO-8601) | no | **Valid time** of the asserted fact (its event time). Omit to stamp `validFrom = now`. |
| `supersede` | boolean | no | Treat as a single-valued fact: close any other currently-open edge of the same type from the source (preserving history) instead of leaving a contradiction. Default false. |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `relationshipId` | string | Composite identifier: `fromNodeId:relationshipType:toNodeId` |
| `created` | boolean | True if newly created; false if already existed |
| `superseded` | number | Count of prior open edges closed by supersession (0 when `supersede=false`) |

## Bi-temporal validity

Every write stamps the edge with bi-temporal validity: `validFrom` (valid-time start, from `observedAt` or now) + `recordedAt` (transaction-time start, now), with `validTo` / `invalidatedAt` left null (still true / still known). Re-asserting an edge reopens it if a prior supersession had closed it. Reads (`ontology.query`, `ontology.neighbors`) default to currently-valid, currently-known and accept `asOf` / `asKnownAt` for time-travel. See `@oxagen/ontology/temporal`.

## Example

**Request:**
```http
PUT /v1/graph/relationships
Content-Type: application/json

{
  "fromNodeId": "kn_cust_001",
  "toNodeId": "kn_contract_042",
  "relationshipType": "SIGNED_CONTRACT",
  "properties": {
    "signedDate": "2026-06-01",
    "value": "150000"
  }
}
```

**Response:**
```json
{
  "relationshipId": "kn_cust_001:SIGNED_CONTRACT:kn_contract_042",
  "created": true
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- **Open-vocabulary relationship type:** any `SCREAMING_SNAKE_CASE` type is accepted. The `RELATIONSHIP_TYPE_PATTERN` lexical guard (`/^[A-Z][A-Z0-9_]{0,62}$/`) prevents Cypher injection.
- Schema validation (if enforcement is not `off`) will additionally check the type against `schema.relationship.upsert` definitions. Unknown types may be rejected or warned depending on enforcement mode.
- Use `schema.validate.relationship` for a pre-flight check before bulk writes.

## Related
- `graph.edge.upsert` — deprecated alias; removed in v2
- `graph.node.upsert` — create or update the nodes connected by this relationship
- `schema.relationship.upsert` — define a relationship type in the workspace schema
- `schema.validate.relationship` — pre-flight validate a relationship before writing
