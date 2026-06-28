# browser.click

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Click an element (by CSS selector) on the durable sandbox browser's current page.
Playwright auto-waits for the element to be visible and actionable before clicking.

Use for UI interactions that are not form submissions — e.g. opening a dropdown,
navigating to a tab, or triggering a button that mutates state without a full-page
navigation.

## Input

| Field       | Type      | Default  | Notes                                                              |
| ----------- | --------- | -------- | ------------------------------------------------------------------ |
| `sessionId` | `string`  | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required. |
| `selector`  | `string`  | —        | CSS selector of the element to click. Required.                    |
| `timeoutMs` | `integer` | `60000`  | Element actionability timeout in milliseconds (1000–120000).       |

## Output

| Field | Type      | Notes                                          |
| ----- | --------- | ---------------------------------------------- |
| `ok`  | `boolean` | `true` when the click completed.               |
| `url` | `string`  | The page URL after the click settles.          |

## API

```
POST /v1/{org}/{workspace}/browser/click
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "selector": "nav a[href='/settings']"
}
```

Response:

```json
{
  "ok": true,
  "url": "http://localhost:3000/settings"
}
```

## MCP

Tool name: `browser.click`

## Notes

- Playwright waits for the element to be attached, visible, stable, and not
  obscured before dispatching the click event.
- If the click triggers a navigation, the URL in the output reflects the settled
  destination.
- For form submission buttons, prefer `browser.submit` (it waits for
  network/navigation settle explicitly).
