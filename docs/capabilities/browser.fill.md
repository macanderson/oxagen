# browser.fill

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Fill a form field (by CSS selector) on the durable sandbox browser's current page.
Playwright auto-waits for the element to be visible and editable before typing.

Browser state is **shared across calls** — a value filled here persists to a
subsequent `browser.submit` or `browser.click`. This lets the agent fill multiple
fields one at a time before submitting a form.

## Input

| Field       | Type      | Default  | Notes                                                              |
| ----------- | --------- | -------- | ------------------------------------------------------------------ |
| `sessionId` | `string`  | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required. |
| `selector`  | `string`  | —        | CSS selector for the input / textarea / select. Required.          |
| `value`     | `string`  | —        | Value to set. An empty string clears the field.                    |
| `timeoutMs` | `integer` | `30000`  | Element wait timeout in milliseconds (1000–60000).                 |

## Output

| Field | Type      | Notes                   |
| ----- | --------- | ----------------------- |
| `ok`  | `boolean` | `true` on success.      |

## API

```
POST /v1/{org}/{workspace}/browser/fill
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "selector": "#email",
  "value": "user@example.com"
}
```

Response:

```json
{ "ok": true }
```

## MCP

Tool name: `browser.fill`

## Notes

- Uses Playwright's `fill()` — the field is cleared first, then the value is typed
  atomically. Use `browser.click` before `browser.fill` if the field requires focus.
- Pair with `browser.submit` to complete a form flow end-to-end.
- An empty `value` clears the current field content.
