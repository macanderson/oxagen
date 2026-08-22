# code.diff

**Domain:** code
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Produce a unified diff between two file blobs (a `before` and an `after`), along
with added and removed line counts. The diff is computed in-process — it is a
deterministic, side-effect-free text transformation with no code execution, so
no sandbox is involved.

## Input

| Field          | Type      | Default  | Notes                                                       |
| -------------- | --------- | -------- | ----------------------------------------------------------- |
| `before`       | `string`  | required | Original contents (the `a` side); capped at 1 MiB           |
| `after`        | `string`  | required | New contents (the `b` side); capped at 1 MiB                |
| `path`         | `string`  | `"file"` | Path used in the diff's `---`/`+++` headers                 |
| `contextLines` | `integer` | `3`      | Unchanged context lines around each hunk (0–100)            |

## Output

| Field       | Type      | Notes                                              |
| ----------- | --------- | -------------------------------------------------- |
| `diff`      | `string`  | Unified diff text; empty string when identical     |
| `changed`   | `boolean` | True when the two blobs differ                     |
| `additions` | `integer` | Count of added lines                               |
| `deletions` | `integer` | Count of removed lines                             |

## Side effects

None — pure computation.

## API

```
POST /v1/{org}/{workspace}/code/diff
Content-Type: application/json

{
  "before": "hello\n",
  "after": "world\n",
  "path": "greeting.txt"
}
```

## MCP

Tool name: `code.diff` (read-only, idempotent).

## Errors

- Rejects either blob larger than 1 MiB at the schema boundary.
