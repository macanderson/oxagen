# documents.pdf.create

**Domain:** documents
**Mode:** sync
**Scope:** tenant + workspace
**Status:** stub — console-logging placeholder; real backing deferred.

## Intent

Render a PDF from either a raw HTML string or an existing cloud file. Optionally applies a
brand kit to the output. When `brandKitId` is supplied the handler emits a `brandkit.apply`
log line so the intent is traceable.

## Input

| Field          | Type               | Notes                                                                    |
| -------------- | ------------------ | ------------------------------------------------------------------------ |
| `title`        | `string` (min 1)   | Title / filename of the output PDF.                                      |
| `sourceHtml`   | `string` (optional)| Raw HTML markup to render into a PDF.                                    |
| `sourceFileId` | `string` (optional)| Cloud file ID of a document to export as PDF.                            |
| `brandKitId`   | `string` (optional)| Brand kit to apply to the PDF output; triggers a `brandkit.apply` log.  |

## Output

| Field    | Type          | Notes                                                    |
| -------- | ------------- | -------------------------------------------------------- |
| `stub`   | `true`        | Constant marker — always `true` until backing is wired.  |
| `fileId` | `string`      | Placeholder ID of the form `stub_<uuid>`.                |
| `url`    | `string` (URL)| Placeholder URL of the form `https://stub.invalid/<id>`. |

## Side effects (stub)

- `console.log("[stub] documents.pdf.create — would render PDF …")`
- If `brandKitId` is set: `console.log("[stub] brandkit.apply <id> -> <fileId>")`

## Errors

The handler does not throw. Any Zod validation failure is surfaced as a `400 Bad Request`
by the route layer.

| code              | meaning                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `400 Bad Request` | Input failed Zod validation (missing title, etc.).                    |
| `401 Unauthorized`| No valid session or API key.                                          |
| `403 Forbidden`   | Caller lacks `documents.pdf.create` permission for the org/workspace. |

## API route

`POST /v1/:org_slug/:workspace_slug/documents/pdf`

## SPEC references

- §11 — Document generation and brand-kit application (deferred)
- §7.3 — documents domain handler conventions
