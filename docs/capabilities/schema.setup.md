# schema.setup

Interactive LLM-assisted registry setup wizard — orchestrates `schema.recommend` → `schema.chat` Q&A → `schema.label.upsert` / `schema.relationship.upsert` → `schema.toggle` under one interactive flow.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/setup`
- MCP: `schema.setup`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `sampleLimit` | integer (1–5000) | no | Nodes to sample for the recommendation phase; default 200 |
| `enforcement` | `strict` \| `lenient` \| `off` | no | Enforcement mode to set on activation |
| `noInteractive` | boolean | no | Apply recommendation verbatim and activate without Q&A (useful for CI scripting) |
| `json` | boolean | no | Return machine-readable JSON output instead of an interactive display |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `schemasCreated` | number | Number of schemas created |
| `labelsCreated` | number | Number of labels created |
| `relationshipTypesCreated` | number | Number of relationship types created |
| `pinnedVersionId` | string \| null | The version pinned after setup (null if aborted) |

## Example

**Request:**
```http
POST /v1/schema/setup
Content-Type: application/json

{
  "sampleLimit": 300,
  "enforcement": "lenient",
  "noInteractive": true
}
```

**Response:**
```json
{
  "schemasCreated": 2,
  "labelsCreated": 5,
  "relationshipTypesCreated": 4,
  "pinnedVersionId": "ver_001"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- In interactive mode (default), the wizard presents the recommendation and allows the user to refine it via natural-language Q&A before applying.
- `noInteractive: true` is the recommended flag for CI/scripting: it applies the recommendation verbatim and activates without prompts.
- If aborted mid-wizard, no changes are committed — the draft remains unchanged.

## Related
- `schema.recommend` — recommendation step in isolation (no wizard)
- `schema.chat` — iterative Q&A step in isolation
- `schema.toggle` — activate the schema after manual setup
- `schema.registry.get` — verify the result after setup
