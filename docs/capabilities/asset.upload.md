# asset.upload

**Domain:** asset
**Mode:** sync
**Scope:** tenant

## Intent

Ingest a binary asset from a publicly reachable source URL into object storage
and return the stored CDN URL, canonical key, detected content type, and byte
size. The asset is fetched server-side (with SSRF protection), validated against
kind-specific size and content-type limits, and stored via the vendor-neutral
`@oxagen/storage` adapter (Vercel Blob today; S3 / R2 tomorrow without any
import-site changes).

Used by the agent when it needs to persist a generated or referenced image,
document, or avatar into the workspace's file store.

## Input

| Field            | Type                                            | Notes                                                                          |
| ---------------- | ----------------------------------------------- | ------------------------------------------------------------------------------ |
| `sourceUrl`      | `string` (URL)                                  | Publicly routable `http://` or `https://` URL. Private IPs / localhost blocked. |
| `kind`           | `"avatar" \| "image" \| "document" \| "video"`  | Determines allowed content types and size limit.                               |
| `filename`       | `string` (1–200 chars) — optional               | Original filename for display only; never influences the storage path.         |
| `source`         | `"user_upload"` — optional                      | Omit for a pure public-blob ingest (no DB row). Pass `"user_upload"` to record a private `generated_assets` attachment row. See **User-upload mode** below. |
| `conversationId` | `string` — optional                             | Conversation public ID to link the asset to. Requires `source: "user_upload"`. |

### Kind limits

| Kind       | Max size | Allowed MIME types                                          |
| ---------- | -------- | ---------------------------------------------------------- |
| `avatar`   | 5 MiB    | `image/webp`, `image/png`, `image/jpeg`                    |
| `image`    | 5 MiB    | `image/webp`, `image/png`, `image/jpeg`, `image/gif`       |
| `document` | 25 MiB   | `image/webp`, `image/png`, `image/jpeg`, `image/gif`, `application/pdf` |
| `video`    | 100 MiB  | `video/mp4`, `video/webm`, `video/quicktime`               |

## Output

| Field         | Type                     | Notes                                                                                                 |
| ------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `url`         | `string`                 | Legacy path: public CDN URL. User-upload path: the relative, access-controlled `/api/v1/assets/:publicId` serving path (the underlying blob is private). |
| `key`         | `string`                 | Canonical storage key, e.g. `image/org-123/uuid.webp`.                                                 |
| `contentType` | `string`                 | MIME type of the stored object.                                                                       |
| `bytes`       | `number` (integer ≥ 0)   | Byte size written — useful for quota accounting.                                                       |
| `publicId`    | `string \| null`         | Public id (`gen_…`) of the recorded `generated_assets` row. Null unless `source: "user_upload"`.      |

## User-upload mode (`source: "user_upload"`)

The default (no `source`) is the legacy pure blob-ingest: a **public** blob and
no Postgres row — backward compatible with every existing avatar/image/document
caller (`publicId` comes back `null`).

Passing `source: "user_upload"` additionally records a `generated_assets`
reference row so the asset behaves like any other conversation asset:

- Blob stored with **private** access (never a publicly-guessable CDN URL);
  served exclusively through the access-controlled `/api/v1/assets/:publicId`
  route.
- Row recorded with `source = 'user_upload'`, `prompt = ''`, `model = ''`,
  `accessPolicy = 'org'`, via the shared `persistGeneratedAsset` chokepoint.
- Appears in `conversation.files.list` (when linked via `conversationId`) and
  can be linked later with `conversation.attachment.add`.

Not supported for `kind: "avatar"`, and requires an authenticated user (an
API-key-only principal is rejected — the row needs an owning `userId`).

## Side effects

- Object storage: one write via `storage().put()` — `access: "public"` for the
  legacy path, `access: "private"` for `source: "user_upload"`.
- Postgres: none for the legacy path; one `generated_assets` insert for
  `source: "user_upload"` (the reference row per the four-store model).
- ClickHouse: kernel security event emitted on every invocation (allow/deny).

## Surfaces

| Surface | Path                                                            |
| ------- | --------------------------------------------------------------- |
| API     | `POST /v1/:org_slug/:workspace_slug/assets/upload`             |
| MCP     | Tool `asset.upload` (streamable HTTP at `/mcp`)                |
| Agent   | Available to the in-app agent; `requiresApproval: false`       |

## Auth & roles

- Requires a resolved principal (`userId` or `apiKeyId`) and an `orgId` in context.
- Default effect: **deny** — explicit role grant required.
- Default grants:

| Level       | Role    | Effect  |
| ----------- | ------- | ------- |
| Org         | Owner   | allow   |
| Org         | Admin   | allow   |
| Workspace   | Owner   | allow   |
| Workspace   | Member  | allow   |

## SSRF protection

The handler enforces server-side fetch safety before making any outbound
request:
- Only `http://` and `https://` schemes are allowed.
- IPv4 private ranges (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 0/8),
  IPv6 loopback/link-local/unique-local (`::1`, `fe80::/10`, `fc00::/7`),
  and bare hostnames `localhost` and `metadata.google.internal` are rejected.

## Errors

| Condition                          | Thrown message                                     |
| ---------------------------------- | -------------------------------------------------- |
| No authenticated principal         | `Unauthorized: no authenticated principal`         |
| Missing org scope                  | `Forbidden: orgId is required to upload assets`    |
| Private / loopback URL             | `Refusing to fetch non-public URL: …`              |
| HTTP error from source URL         | `asset.upload: source URL responded with HTTP NNN` |
| Unsupported content type           | `Unsupported <kind> type "…". Permitted types: …`  |
| Asset too large                    | `Asset exceeds the N byte limit (M MiB) for kind …`|
| `user_upload` with `kind: avatar`  | `asset.upload: source "user_upload" is not supported for kind "avatar"` |
| `user_upload` without a user       | `asset.upload: source "user_upload" requires an authenticated user …` |
| `conversationId` without `source`  | `asset.upload: conversationId requires source "user_upload"` |

## SPEC references

- Storage: `[[storage-vercel-blob-adapter]]` memory entry
- Generated assets pipeline: `[[generated-assets-and-media-pipeline]]` memory entry
- SSRF policy: handler `assertPublicHttpUrl` in `packages/handlers/src/asset.upload.ts`
