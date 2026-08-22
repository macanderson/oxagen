# markdown.generate

**Domain:** documents
**Mode:** sync
**Scope:** tenant + workspace
**Status:** live — fully wired (contract → handler → API route → MCP tool).

## Intent

Persist a Markdown document as a first-class generated asset. Raw Markdown source (or a
structured sections fallback) is encoded to UTF-8 bytes, uploaded to blob storage, and served
through the access-controlled `/api/v1/assets/<publicId>` route. No cloud OAuth required —
the operation is fully in-process. Emits a `file-attachment` render directive so the chat
renders a downloadable file card without knowing the output kind.

## Input

| Field      | Type                                                     | Notes                                                                                      |
| ---------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `title`    | `string` (min 1)                                         | Title / filename of the output document (without `.md` extension).                         |
| `markdown` | `string` (optional)                                      | Raw Markdown source. When provided, persisted verbatim.                                    |
| `sections` | `Array<{heading?: string; paragraphs: string[]}>` (opt) | Structured fallback used when `markdown` is absent. Assembled into CommonMark (H1 + H2s). |

At least one of `markdown` or `sections` should be provided. When neither is supplied the
handler falls back to an H1-only document derived from `title`.

## Output

| Field      | Type                    | Notes                                                        |
| ---------- | ----------------------- | ------------------------------------------------------------ |
| `assetId`  | `string`                | Internal UUID of the `content.generated_assets` row. Stored under the DB `document` kind (the `generated_assets_kind_check` constraint has no dedicated `markdown` kind); the output/render `kind` below is the client-facing Markdown hint. |
| `publicId` | `string`                | User-facing `gen_…` ID used in URLs and the serving route.  |
| `kind`     | `"markdown"`            | Always `"markdown"` (render hint for the file-attachment card). |
| `mimeType` | `"text/markdown"`       | Always `"text/markdown"`.                                    |
| `sizeBytes`| `number`                | Size of the encoded UTF-8 bytes.                             |
| `url`      | `string`                | Internal blob storage URL (do not expose to end-users).      |
| `serveUrl` | `string`                | Access-controlled serving path `/api/v1/assets/<publicId>`.  |
| `render`   | `fileRenderDirective`   | `{ componentId: "file-attachment", props: { … } }` for chat.|

## Render directive

The `render` field instructs the chat renderer to mount the `file-attachment` component:

```json
{
  "componentId": "file-attachment",
  "props": {
    "url": "/api/v1/assets/gen_XXX",
    "name": "My Document.md",
    "kind": "markdown",
    "mimeType": "text/markdown",
    "sizeBytes": 512
  }
}
```

## API route

`POST /v1/:org_slug/:workspace_slug/markdown/generate`

**Request body** (JSON):

```json
{
  "title": "My Document",
  "markdown": "# My Document\n\nHello world."
}
```

**Response** (`200 OK`): the output shape above.

## MCP tool

Tool name: `markdown.generate`

Available as `markdown.generate` in the MCP tool list. Accepts `title`, `markdown`, and
`sections` parameters.

## Errors

| Code               | Meaning                                                              |
| ------------------ | -------------------------------------------------------------------- |
| `400 Bad Request`  | Input failed Zod validation (empty title, empty paragraphs, etc.).   |
| `401 Unauthorized` | No valid session or API key.                                         |
| `403 Forbidden`    | Caller lacks `markdown.generate` permission for the org/workspace.   |
| `500` (thrown)     | `persistGeneratedAsset` failed (blob upload or DB insert error).     |

## Plugin pack

`markdown.generate` is included in the **oxagen/documents** capability pack. Installing the
documents pack grants this capability.

## SPEC references

- §11 — Document generation capabilities (documents domain)
- §7.3 — Documents domain handler conventions
- `docs/capabilities/documents.generate.md` — sibling capability (DOCX/XLSX/PPTX)
- `docs/capabilities/documents.pdf.create.md` — sibling capability (PDF)
