# schema.chat

AI iterative schema builder turn — takes a conversation and the current draft, and returns an assistant message plus proposed mutation tool calls. The inner Q&A loop of the schema setup wizard.

## Mode
**sync**

## Surfaces
- API: `POST /v1/schema/chat`
- MCP: `schema.chat`
- Agent: callable (no approval required, risk: low)

## Input
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message` | string (1–10000 chars) | yes | User's natural-language instruction or question about the schema |
| `conversationId` | string | no | Resume an existing schema-chat conversation thread |
| `draftVersionId` | string | no | Draft to work against; defaults to the current draft |

## Output
| Field | Type | Description |
|-------|------|-------------|
| `assistantMessage` | string | LLM-generated response explaining the proposed changes |
| `proposedMutations` | object[] \| undefined | Mutation tool calls to apply if the user accepts |
| `proposedMutations[].capability` | string | Contract name (e.g. `schema.label.upsert`) |
| `proposedMutations[].input` | object | Ready-to-use input object for that contract call |
| `conversationId` | string | Thread ID for continuation in the next turn |

## Example

**Request:**
```http
POST /v1/schema/chat
Content-Type: application/json

{
  "message": "Add a Contract label to the CRM schema with a value property (number) and a signedAt property (datetime)",
  "conversationId": "chat_schema_xyz"
}
```

**Response:**
```json
{
  "assistantMessage": "I'll add a Contract label to the CRM schema with `value` (number) and `signedAt` (datetime) properties. Here are the proposed mutations — confirm to apply them.",
  "proposedMutations": [
    {
      "capability": "schema.label.upsert",
      "input": {
        "schemaName": "crm",
        "name": "Contract",
        "displayName": "Contract",
        "properties": [
          { "key": "value", "dataType": "number", "required": false },
          { "key": "signedAt", "dataType": "datetime", "required": false }
        ]
      }
    }
  ],
  "conversationId": "chat_schema_xyz"
}
```

## Notes
- **Access:** Org: Owner/Admin; Workspace: Owner/Member.
- Sensitivity: medium.
- Agent surface only — this conversational capability has no API or MCP surface.
- **Proposes mutations but never executes them directly.** The caller must invoke the proposed capabilities to apply changes — this preserves the human-in-the-loop approval pattern.
- Pass `conversationId` from the previous response to continue a multi-turn session.
- Makes one LLM call through `@oxagen/ai` (metered) per turn.

## Related
- `schema.setup` — full wizard that orchestrates schema.chat internally
- `schema.recommend` — AI recommendation without a Q&A turn
- `schema.label.upsert` — apply a label mutation from `proposedMutations`
- `schema.relationship.upsert` — apply a relationship type mutation from `proposedMutations`
