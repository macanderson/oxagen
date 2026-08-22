# code.format

**Domain:** code
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Run a language-aware formatter on source code **inside the sandbox** and return
the formatted text. The formatter is a fixed, standard-library-only driver that
never executes the caller's source; it runs through the same sandbox driver
abstraction (resource limits, network deny, filesystem isolation) as
`agent.code.execute`. Sandbox availability is gated by `SANDBOX_ENABLED=true`
and a configured driver.

## Supported languages

| Language | How it is formatted (stdlib-only, no network)                                                  |
| -------- | ---------------------------------------------------------------------------------------------- |
| `json`   | `json.loads` + `json.dumps` round-trip — lossless structural re-indent.                        |
| `python` | `ast.parse` + `ast.unparse` canonical normalization (Python 3.9+). **Note:** this is a canonicaliser, not a style formatter — it drops comments and normalizes whitespace/quotes. |

These are the languages the stock, network-isolated sandbox images can format
with zero extra tooling. The language enum is the extension point for adding
richer formatters (e.g. `black`, `prettier`) once the images carry them.

## Input

| Field      | Type                   | Default  | Notes                                            |
| ---------- | ---------------------- | -------- | ------------------------------------------------ |
| `language` | `"json" \| "python"`   | required | Language to format                               |
| `source`   | `string`               | required | Source code to format; capped at 1 MiB           |
| `indent`   | `integer`              | `2`      | Indent width in spaces (json only; 0–8)          |

## Output

| Field       | Type                   | Notes                                              |
| ----------- | ---------------------- | -------------------------------------------------- |
| `formatted` | `string`               | The formatted source                               |
| `changed`   | `boolean`              | True when the output differs from the input        |
| `language`  | `"json" \| "python"`   | Echo of the requested language                     |

## Side effects

None — the sandbox is ephemeral and torn down after each run. The run's wall-clock
duration is metered to ClickHouse (`code.format.ran`).

## API

```
POST /v1/{org}/{workspace}/code/format
Content-Type: application/json

{
  "language": "json",
  "source": "{\"a\":1}",
  "indent": 2
}
```

## MCP

Tool name: `code.format` (read-only, idempotent).

## Errors

- Throws if `SANDBOX_ENABLED` is not `true` or the driver is not configured.
- Throws when the source cannot be parsed (e.g. a Python `SyntaxError` or invalid JSON).
- Throws if the formatter run times out.
