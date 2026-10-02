# create_work_item

Enter a work item by hand (lane P1-03, #5103). The item takes the workspace's next number, such as `WI-19`, and goes to triage like an issue a GitHub collector brought in.

**Surfaces:** api, mcp

## Surface

- API: `POST /v1/:org_slug/:workspace_slug/work/items/create`, returns 201
- MCP: `create_work_item`
- Authentication: org Owner or Admin, or workspace Owner or Member, checked by the handler
- Billing: `noBillingGate: true`. Triage of the item is charged as in-app assistant spend on the Billing page.
- Not on the agent surface.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `subject` | `string` | 1 to 300 characters |
| `description` | `string?` | Up to 20,000 characters |
| `labels` | `string[]` | Up to 20 labels. A Priority label (`P0` to `P3`) sets the item's priority |
| `repository` | `string?` | The repository the work belongs to, as `owner/name` |

## Output

| Field | Type | Notes |
| --- | --- | --- |
| `item_id` | `string` | The `wi_…` public id |
| `number` | `string` | The workspace's number, such as `WI-19` |
| `state` | `string` | `new` |
| `revision` | `int` | 1 |
| `version` | `int` | The concurrency token a later action names |

## Semantics

The subject, description, and labels pass a credential screen before they are stored: a token, key, or private key in them is replaced by a marker. The screen finds the credential shapes it knows, so text can still hold sensitive content. The item records an `entered` fact on revision 1 (ADR-244), and `work/item.received` queues triage. Nothing is written to any provider.
