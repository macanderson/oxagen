# integration.configure

Update a plugin instance's config: credentials, sync cadence, inference toggles, and ontology prompts.

## Mode
**sync**

## Surfaces
- API: `PATCH /v1/integrations/:id/configure`
- MCP: `integration.configure`
- Agent: callable (no approval required, risk: medium)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `integrationId` | string | yes | Plugin instance ID |
| `displayName` | string | no | Update the display name |
| `config` | Record\<string, unknown\> | no | Updated config fields (merged with existing) |
| `syncCadence` | `"manual"` \| `"polling"` \| `"webhook"` | no | Update sync trigger method |
| `inferenceEnabled` | boolean | no | Enable or disable LLM inference |
| `ontologyPrompt` | string | no | Custom prompt for entity extraction from this source |
| `semanticEdgePrompt` | string | no | Custom prompt for cross-source relationship inference |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `integrationId` | string | Plugin instance ID |
| `displayName` | string | Current display name |
| `syncCadence` | string | Active sync trigger method |
| `inferenceEnabled` | boolean | Whether LLM inference is enabled |
| `updatedAt` | string | ISO-8601 timestamp of the update |

## Example

**Request:**
```http
PATCH /v1/integrations/intg_def789/configure
Content-Type: application/json

{
  "inferenceEnabled": true,
  "syncCadence": "webhook",
  "ontologyPrompt": "Extract Jira issues as Feature nodes and link to affected services."
}
```

**Response:**
```json
{
  "integrationId": "intg_def789",
  "displayName": "Jira — Platform team",
  "syncCadence": "webhook",
  "inferenceEnabled": true,
  "updatedAt": "2026-06-10T13:00:00Z"
}
```

## Notes
- **Access:** Owner or Admin at org level; Owner or Member at workspace level.
- Config updates are merged (PATCH semantics); omitted fields retain their current values.
- Changing `inferenceEnabled` or `ontologyPrompt` does not re-process existing graph data. Use `integration.sync` with `mode: "full"` to re-ingest.
- `semanticEdgePrompt` affects cross-source edge inference, not single-source entity extraction.

## Related
- `integration.install` — install a new plugin instance
- `integration.sync` — trigger sync after config changes
- `integration.get` — retrieve full integration details
- `repo.configure` — equivalent for repository connectors
