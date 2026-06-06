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

| Field       | Type                                        | Notes                                                                          |
| ----------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `sourceUrl` | `string` (URL)                              | Publicly routable `http://` or `https://` URL. Private IPs / localhost blocked. |
| `kind`      | `"avatar" \| "image" \| "document"`         | Determines allowed content types and size limit.                               |
| `filename`  | `string` (1–200 chars) — optional           | Original filename for display only; never influences the storage path.         |

### Kind limits

| Kind       | Max size | Allowed MIME types                          |
| ---------- | -------- | ------------------------------------------- |
| `avatar`   | 5 MiB    | `image/webp`, `image/png`, `image/jpeg`     |
| `image`    | 5 MiB    | `image/webp`, `image/png`, `image/jpeg`     |
| `document` | 25 MiB   | `image/webp`, `image/png`, `image/jpeg`, `application/pdf` |

## Output

| Field         | Type                     | Notes                                                     |
| ------------- | ------------------------ | --------------------------------------------------------- |
| `url`         | `string` (URL)           | Public CDN URL the stored asset is served from.           |
| `key`         | `string`                 | Canonical storage key, e.g. `image/org-123/uuid.webp`.   |
| `contentType` | `string`                 | MIME type of the stored object.                           |
| `bytes`       | `number` (integer ≥ 0)   | Byte size written — useful for quota accounting.          |

## Side effects

- Object storage: one write via `storage().put()` (Vercel Blob, `access: "public"`).
- Postgres: none (the caller is responsible for persisting the `url`/`key` reference row).
- ClickHouse: kernel security event emitted on every invocation (allow/deny).
- Neo4j: none.

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

## SPEC references

- Storage: `[[storage-vercel-blob-adapter]]` memory entry
- Generated assets pipeline: `[[generated-assets-and-media-pipeline]]` memory entry
- SSRF policy: handler `assertPublicHttpUrl` in `packages/handlers/src/asset.upload.ts`
