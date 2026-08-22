# schema.recommend

AI onboarding — reads the existing graph (via `graph.stats`, observed labels from ClickHouse telemetry, and sampled ontology queries) along with the workspace's enabled schemas to propose a starter schema or targeted additions. Returns a proposal only — no mutations are made.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/recommend`
- MCP: `schema.recommend`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sampleLimit` | integer (1–5000) | no | Number of observed graph nodes to sample for the recommendation; default 200 |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `proposal` | object | The AI-generated schema proposal |
| `proposal.schemas` | object[] | Proposed schemas |
| `proposal.schemas[].name` | string | Schema name |
| `proposal.schemas[].displayName` | string | Human label |
| `proposal.schemas[].labels` | object[] | Proposed node labels with optional property suggestions |
| `proposal.schemas[].relationshipTypes` | object[] | Proposed relationship types with `startLabel`, `endLabel`, and `description` |
| `rationale` | string | Plain-language explanation of why this schema was recommended |
| `sampledCount` | integer | Number of nodes sampled to produce the recommendation |

## Example

**Request:**
```http
POST /v1/schema/recommend
Content-Type: application/json

{
  "sampleLimit": 500
}
```

**Response:**
```json
{
  "proposal": {
    "schemas": [
      {
        "name": "crm",
        "displayName": "CRM",
        "labels": [
          { "name": "Customer", "displayName": "Customer", "description": "A B2B customer account" },
          { "name": "Contract", "displayName": "Contract", "description": "A signed customer contract" }
        ],
        "relationshipTypes": [
          {
            "name": "SIGNED_CONTRACT",
            "displayName": "Signed Contract",
            "startLabel": "Customer",
            "endLabel": "Contract",
            "description": "A customer has signed this contract"
          }
        ]
      }
    ]
  },
  "rationale": "Your graph contains 1,200 nodes with informal labels like 'account' and 'deal'. I've normalized these into a CRM schema with Customer and Contract labels and a SIGNED_CONTRACT relationship.",
  "sampledCount": 500
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- Makes one LLM call through `@oxagen/ai` (metered).
- Returns a **proposal only** — no mutations are made to the schema or graph.
- To apply the proposal: pass its labels and relationship types to `schema.label.upsert` / `schema.relationship.upsert`, or use `schema.setup` for the full interactive wizard.

## Related
- `schema.setup` — full interactive wizard: recommend → Q&A → apply → activate
- `schema.chat` — iterative AI-guided schema building
- `schema.label.upsert` — apply a specific label from the proposal
- `schema.relationship.upsert` — apply a specific relationship type from the proposal
