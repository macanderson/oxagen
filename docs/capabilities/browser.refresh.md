# browser.refresh

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Reload the durable sandbox browser's current page and wait for load. Use after a
rebuild or HMR update to re-check that a feature renders correctly with the latest
code, without navigating away from the current URL.

## Input

| Field       | Type      | Default  | Notes                                                              |
| ----------- | --------- | -------- | ------------------------------------------------------------------ |
| `sessionId` | `string`  | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required. |
| `timeoutMs` | `integer` | `60000`  | Page load timeout in milliseconds (1000–120000).                   |

## Output

| Field | Type      | Notes                          |
| ----- | --------- | ------------------------------ |
| `ok`  | `boolean` | `true` on successful reload.   |
| `url` | `string`  | The page URL after reload.     |

## API

```
POST /v1/{org}/{workspace}/browser/refresh
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "timeoutMs": 30000
}
```

Response:

```json
{
  "ok": true,
  "url": "http://localhost:3000/dashboard"
}
```

## MCP

Tool name: `browser.refresh`

## Notes

- Equivalent to pressing F5 on the current page — the browser re-fetches the URL
  and waits for the `load` event.
- After a hot-module-reload (HMR) update or a server restart, call `browser.refresh`
  before `browser.screenshot` to ensure the latest build is rendered.
- Does not change the URL; if a redirect occurs on refresh, the output `url` reflects
  the settled destination.
