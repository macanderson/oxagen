# browser.screenshot

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Screenshot the durable sandbox browser's current page (or a CSS-selected element)
and store it as a **private workspace blob**. Returns the asset key and URL so the
cross-LLM judge (`agent.feature.verify`) can inspect the rendered output.

Screenshots are the primary evidence artifact in the durable sandbox proof-of-done
loop: build → navigate → screenshot → judge.

## Input

| Field       | Type       | Default  | Notes                                                                            |
| ----------- | ---------- | -------- | -------------------------------------------------------------------------------- |
| `sessionId` | `string`   | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required.               |
| `selector`  | `string?`  | —        | Optional CSS selector — capture only that element instead of the full page.      |
| `fullPage`  | `boolean`  | `false`  | Capture the full scrollable page rather than just the viewport.                  |
| `timeoutMs` | `integer`  | `60000`  | Timeout in milliseconds (1000–120000).                                           |

## Output

| Field    | Type      | Notes                                                                  |
| -------- | --------- | ---------------------------------------------------------------------- |
| `key`    | `string`  | Private storage key — pass to `agent.feature.verify`.                  |
| `url`    | `string`  | Storage URL (private; bytes served via authenticated read).             |
| `width`  | `integer` | PNG width in pixels.                                                   |
| `height` | `integer` | PNG height in pixels.                                                  |
| `bytes`  | `integer` | PNG byte length.                                                       |

## API

```
POST /v1/{org}/{workspace}/browser/screenshot
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "fullPage": true
}
```

Response:

```json
{
  "key": "ws/sbx_01abc.../screenshot_20260628T120000Z.png",
  "url": "https://blob.oxagen.sh/ws/sbx_01abc.../screenshot_20260628T120000Z.png",
  "width": 1280,
  "height": 2400,
  "bytes": 142312
}
```

## MCP

Tool name: `browser.screenshot`

## Notes

- Screenshots are stored as private workspace assets — access requires org+workspace
  authentication; the public URL is not directly accessible without a signed token.
- Pass the returned `key` to `agent.feature.verify` for cross-LLM visual inspection.
- `fullPage: true` scrolls and stitches the complete page; omit for a viewport-only
  capture, which is faster and sufficient for most proofs.
- Pair with `browser.navigate` or `browser.refresh` before taking the screenshot to
  ensure the latest state is visible.
