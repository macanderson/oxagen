# archive.create

**Domain:** documents
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low

## Intent

Bundle one or more items — existing generated assets (by public ID), inline base64 blobs, or plain text — into a ZIP archive. The archive is built in-process with fflate (no external process), uploaded to Vercel Blob storage, and served through the access-controlled `/api/v1/assets/<publicId>` route. Returns a `file-attachment` render directive for the chat UI.

## Input

| Field | Type | Notes |
|---|---|---|
| `archiveName` | `string` (1+ chars) | Desired filename of the ZIP (without extension). Default: `"archive"`. |
| `entries` | `Entry[]` (1+ items) | Files to bundle. Each entry provides exactly one of `assetId`, `contentBase64`, or `text`. |
| `entries[].name` | `string` (1+ chars) | Filename inside the ZIP (including extension). |
| `entries[].assetId` | `string?` | `gen_…` public ID of an existing generated asset to fetch from storage. |
| `entries[].contentBase64` | `string?` | Raw bytes encoded as base64. |
| `entries[].text` | `string?` | UTF-8 text content. |

## Output

| Field | Type | Notes |
|---|---|---|
| `assetId` | `string` | Internal asset row ID. |
| `publicId` | `string` | `gen_…` public ID used in the `/assets/` route. |
| `kind` | `"archive"` | Always `"archive"`. |
| `mimeType` | `string` | `application/zip`. |
| `sizeBytes` | `number` | Byte size of the produced archive. |
| `url` | `string` | Vercel Blob CDN URL (direct). |
| `serveUrl` | `string` | Access-controlled serve URL (`/api/v1/assets/<publicId>`). |
| `render` | `RenderDirective` | `file-attachment` component directive for chat UI. |

## Roles

Org Owner, Admin. Workspace Owner, Member.

## Side effects

- Blob storage: writes one ZIP object via `@oxagen/storage`.
- Postgres: inserts `content.generated_assets` row.
- ClickHouse: emits `asset.archived` event.

## Surfaces

- `POST /api/v1/{org}/{ws}/archive`
- MCP tool `archive_create`
- Agent: no approval required, risk `low`.

## Errors

| code | meaning |
|---|---|
| `no_entries` | `entries` array is empty. |
| `asset_not_found` | An `assetId` referenced in an entry does not exist or belongs to a different workspace. |
| `storage_error` | Blob upload failed. |
| `unauthorized` | Caller lacks workspace Member role or higher. |
