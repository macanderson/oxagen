# documents.generate

**Domain:** documents
**Mode:** sync
**Scope:** tenant + workspace
**Status:** stub — console-logging placeholder; real backing deferred.

## Intent

Generate a new document, spreadsheet, or presentation in a cloud provider (Google Workspace
or Microsoft 365).

## Input

| Field          | Type                                            | Notes                                                 |
| -------------- | ----------------------------------------------- | ----------------------------------------------------- |
| `provider`     | `"google" \| "microsoft"`                       | Cloud provider to create the file in.                 |
| `kind`         | `"document" \| "spreadsheet" \| "presentation"` | Type of document to generate.                         |
| `title`        | `string` (min 1)                                | Title of the new document.                            |
| `instructions` | `string` (optional)                             | Natural-language instructions for content generation. |

## Output

| Field      | Type                                            | Notes                                                    |
| ---------- | ----------------------------------------------- | -------------------------------------------------------- |
| `stub`     | `true`                                          | Constant marker — always `true` until backing is wired.  |
| `provider` | `"google" \| "microsoft"`                       | Echoed from input.                                       |
| `kind`     | `"document" \| "spreadsheet" \| "presentation"` | Echoed from input.                                       |
| `fileId`   | `string`                                        | Placeholder ID of the form `stub_<uuid>`.                |
| `url`      | `string` (URL)                                  | Placeholder URL of the form `https://stub.invalid/<id>`. |

## Side effects (stub)

- `console.log("[stub] documents.generate <provider>/<kind> — would generate …")`

## Errors

The handler does not throw. Any Zod validation failure is surfaced as a `400 Bad Request`
by the route layer.

| code               | meaning                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `400 Bad Request`  | Input failed Zod validation (missing provider/kind/title, etc.).    |
| `401 Unauthorized` | No valid session or API key.                                        |
| `403 Forbidden`    | Caller lacks `documents.generate` permission for the org/workspace. |

## API route

`POST /v1/:org_slug/:workspace_slug/documents/generate`

## SPEC references

- §7.3 — documents domain handler conventions
