# brandkit.apply

**Domain:** brandkit
**Mode:** sync
**Scope:** tenant + workspace
**Status:** stub — console-logging placeholder; real backing deferred.

## Intent

Apply a workspace brand kit (colours, fonts, logos) to an existing cloud file. Used directly
by callers and also invoked internally by `documents.generate` and `documents.pdf.create`
when a `brandKitId` is supplied.

## Input

| Field          | Type             | Notes                                                   |
| -------------- | ---------------- | ------------------------------------------------------- |
| `workspaceId`  | `string` (min 1) | The workspace the brand kit belongs to.                 |
| `brandKitId`   | `string` (min 1) | ID of the brand kit to apply.                           |
| `targetFileId` | `string` (min 1) | Cloud file ID of the document to apply the brand kit to.|

## Output

| Field          | Type           | Notes                                                     |
| -------------- | -------------- | --------------------------------------------------------- |
| `stub`         | `true`         | Constant marker — always `true` until backing is wired.   |
| `applied`      | `false`        | Always `false` until the real backing is wired.           |
| `brandKitId`   | `string`       | Echoed from input.                                        |
| `targetFileId` | `string`       | Echoed from input.                                        |

## Side effects (stub)

- `console.log("[stub] brandkit.apply would apply brand kit <id> to <fileId> in workspace <ws>")`

## Errors

The handler does not throw. Any Zod validation failure is surfaced as a `400 Bad Request`
by the route layer.

| code              | meaning                                                            |
| ----------------- | ------------------------------------------------------------------ |
| `400 Bad Request` | Input failed Zod validation (missing workspaceId/brandKitId, etc.).|
| `401 Unauthorized`| No valid session or API key.                                       |
| `403 Forbidden`   | Caller lacks `brandkit.apply` permission for the org/workspace.    |

## API route

`POST /v1/:org_slug/:workspace_slug/brandkit/apply`

## SPEC references

- §11 — Document generation and brand-kit application (deferred)
- §7.4 — brandkit domain handler conventions
