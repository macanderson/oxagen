# browser.submit

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Submit a form on the durable sandbox browser's current page — click the given
submit control by selector, or press Enter when no selector is given — then wait
for the resulting navigation or network activity to settle.

This is a **destructive** action (it mutates server state) — use it after filling
all required fields with `browser.fill`.

## Input

| Field       | Type       | Default  | Notes                                                                                |
| ----------- | ---------- | -------- | ------------------------------------------------------------------------------------ |
| `sessionId` | `string`   | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required.                   |
| `selector`  | `string?`  | —        | CSS selector of the submit control. Omit to press Enter on the currently focused field. |
| `timeoutMs` | `integer`  | `60000`  | Navigation settle timeout in milliseconds (1000–120000).                             |

## Output

| Field | Type      | Notes                                          |
| ----- | --------- | ---------------------------------------------- |
| `ok`  | `boolean` | `true` when the submission completed.          |
| `url` | `string`  | The page URL after submission settles.         |

## API

```
POST /v1/{org}/{workspace}/browser/submit
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "selector": "button[type='submit']",
  "timeoutMs": 30000
}
```

Response:

```json
{
  "ok": true,
  "url": "https://app.oxagen.sh/org/workspace/dashboard"
}
```

## MCP

Tool name: `browser.submit`

## Notes

- Waits for navigation to settle after click/Enter; long server-side operations may
  need a higher `timeoutMs`.
- Follow with `browser.screenshot` to capture proof that the post-submit state
  rendered correctly.
- Treat any `ok: false` as a hard failure and capture a screenshot for the judge.
