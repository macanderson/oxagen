# code.patch

**Domain:** code
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Apply a unified diff to an in-memory, path-confined workspace (a `path → contents`
map) and return only the changed files, each tagged `added`, `modified`, or
`deleted`. The patch is applied in-process: applying a unified diff is pure,
path-confined text manipulation with no code execution, so no sandbox is
involved. The security boundary that matters — path-traversal confinement,
malformed-diff rejection, and size caps — is enforced in-process.

## Input

| Field   | Type                      | Default  | Notes                                                              |
| ------- | ------------------------- | -------- | ------------------------------------------------------------------ |
| `files` | `Record<string, string>`  | required | The workspace the diff applies against; paths confined to the root, capped at 64 files / 5 MiB |
| `diff`  | `string`                  | required | Unified diff to apply (may span multiple files); capped at 2 MiB   |

A target path is resolved from each file header (stripping a leading `a/` or
`b/`). A `/dev/null` old side marks an addition; a `/dev/null` new side marks a
deletion. Every resolved path must stay inside the workspace root — absolute
paths and `..` traversal are rejected.

## Output

| Field          | Type                | Notes                                                       |
| -------------- | ------------------- | ----------------------------------------------------------- |
| `applied`      | `boolean`           | True when every hunk applied cleanly                        |
| `files`        | `CodePatchFile[]`   | Only the changed files (`{ path, status, content }`)        |
| `changedCount` | `integer`           | Number of changed files                                     |

`CodePatchFile.status` is one of `added`, `modified`, or `deleted`. A deleted
file's `content` is the empty string.

## Side effects

None — the result is returned to the caller; nothing is persisted.

## API

```
POST /v1/{org}/{workspace}/code/patch
Content-Type: application/json

{
  "files": { "x.txt": "hello\n" },
  "diff": "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-hello\n+world\n"
}
```

## MCP

Tool name: `code.patch` (read-only, idempotent — it returns computed results and
persists nothing).

## Errors

- Rejects a diff whose target escapes the workspace root (path traversal).
- Rejects a hunk that does not apply cleanly (no partial writes).
- Rejects a malformed diff (e.g. a file patch with no hunks).
