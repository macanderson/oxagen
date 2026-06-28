# browser.read

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Read visible text from the durable sandbox browser's current page (whole page, or
a CSS-selected element) for programmatic assertions. Use to confirm that a success
banner, error message, or specific content appeared without needing a visual
screenshot — faster and cheaper than `browser.screenshot` for text-only checks.

## Input

| Field       | Type       | Default  | Notes                                                                              |
| ----------- | ---------- | -------- | ---------------------------------------------------------------------------------- |
| `sessionId` | `string`   | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required.                 |
| `selector`  | `string?`  | —        | Optional CSS selector — read only that element's text instead of the full page.    |
| `timeoutMs` | `integer`  | `30000`  | Element wait timeout in milliseconds (1000–60000).                                 |

## Output

| Field  | Type     | Notes                                          |
| ------ | -------- | ---------------------------------------------- |
| `text` | `string` | Visible inner text (truncated to ~20k chars).  |

## API

```
POST /v1/{org}/{workspace}/browser/read
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "selector": "[data-testid='success-banner']"
}
```

Response:

```json
{
  "text": "Your changes have been saved."
}
```

## MCP

Tool name: `browser.read`

## Notes

- Returns `innerText` (visible text only, no HTML). Hidden elements are excluded.
- Output is truncated to ~20 000 characters when the page is large; use `selector`
  to scope to the relevant element instead of reading the entire page.
- For visual confirmation, use `browser.screenshot` + `agent.feature.verify`
  (cross-LLM judge) in addition to or instead of text assertions.
- This is a read-only, idempotent operation — safe to call repeatedly.
