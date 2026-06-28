# browser.navigate

**Domain:** browser
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Navigate the durable sandbox's browser to a URL and wait for load. Use to prove
that a feature renders at a given URL (e.g. `http://localhost:3000/dashboard`)
inside the same warm container as the running app.

Browser state is **shared across calls** — the same Playwright daemon (`browserd`)
holds the live page inside the sandbox started by `agent.sandbox.start`. A navigate
in one call is visible in the next `browser.screenshot` or `browser.read` call.

## Input

| Field       | Type      | Default  | Notes                                                              |
| ----------- | --------- | -------- | ------------------------------------------------------------------ |
| `sessionId` | `string`  | —        | Durable-session id (`sbx_…`) from `agent.sandbox.start`. Required. |
| `url`       | `string`  | —        | Absolute URL to navigate to. Must be a valid URL.                  |
| `timeoutMs` | `integer` | `60000`  | Navigation timeout in milliseconds (1000–120000).                  |

## Output

| Field   | Type     | Notes                                   |
| ------- | -------- | --------------------------------------- |
| `url`   | `string` | The final URL after any redirects.      |
| `title` | `string` | The document title after load.          |

## API

```
POST /v1/{org}/{workspace}/browser/navigate
Content-Type: application/json

{
  "sessionId": "sbx_01abc...",
  "url": "http://localhost:3000/dashboard",
  "timeoutMs": 30000
}
```

Response:

```json
{
  "url": "http://localhost:3000/dashboard",
  "title": "Dashboard — Oxagen"
}
```

## MCP

Tool name: `browser.navigate`

## Notes

- Requires an active durable sandbox session (`agent.sandbox.start`) running
  `browserd` on port 9222 inside the container.
- Localhost URLs (e.g. `http://localhost:3000`) resolve inside the sandbox, so
  the browser can hit the app under test directly.
- After navigating, use `browser.screenshot` to capture proof for the
  cross-LLM judge, or `browser.read` for text assertions.
