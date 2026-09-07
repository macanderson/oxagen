# Spec: handlers-media-documents

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: asset.upload, generated-asset.persist, generated-asset.serve
> Last verified: 2026-06-20 (commit 2f628504)
>
> **2026-09-07 note:** [ADR-041](../../adr/ADR-041-runtime-excision.md) deleted
> every generation capability this file used to document — `image.*`,
> `video.generate`, `svg.generate`, `markdown.generate`, `mermaid.generate`,
> `documents.generate`, `documents.pdf.create`, `document.*`, `form.fill`, and
> `archive.create` — along with the async `pending` → `ready` render path
> (`createPendingGeneratedAsset`). `packages/handlers/src` now has no
> image/video/document/form/archive generation files at all. What survives is
> the **attachment half**: a human uploads a file (`asset.upload`,
> `conversation.attachment.add`) or exports a conversation to PDF
> (`conversation.export`), and the governance agent reasons over it —
> `generated-asset.persist.ts` and `generated-asset.serve.ts` are still the
> single seam for that write/read, now always synchronous (every write lands
> `ready`, never `pending`). This file has been trimmed to the requirements
> and invariants that still apply; everything about generation has been
> removed rather than kept as dead prose.

---

### Requirement: Generated asset persisted with dual storage (blob + database)

<!-- id: generated-asset.persist.persistGeneratedAsset -->
<!-- entities: GeneratedAsset, StorageProvider -->
<!-- enforced: generated-asset.persist.ts:persistGeneratedAsset() -->

When media bytes are persisted, they SHALL be uploaded to blob storage with a deterministic key, then a generated_assets row inserted with status `ready`, MIME type, size, storage metadata, and access policy. The storage seam is shared across every surviving write path (`asset.upload`, `conversation.attachment.add`, `conversation.export`).

#### Scenario: Asset uploaded and row inserted

<!-- test: (no existing test found) -->

- **WHEN** persistGeneratedAsset() is called with bytes and metadata
- **THEN** call storage().put() with key derived from kind/orgId/MIME extension, access="private"; extract storageUrl and byte count; insert generated_assets row with status="ready", accessPolicy, storageKey, storageUrl, sizeBytes; return publicId and serveUrl

#### Scenario: Storage key derivation

- **WHEN** MIME type is known (e.g., "image/png" → "png")
- **THEN** use mapped extension; unknown types default to ".bin"

#### Scenario: Insertion failure

- **WHEN** generated_assets insert returns no row
- **THEN** throw error "generated_assets insert failed"

#### Scenario: Tenancy bypass for chat stream context

- **WHEN** called from apps/app chat stream (no runInTenantScope active)
- **THEN** use withSystemDb() for insert; orgId/workspaceId/userId passed explicitly in args (OXA-1515)

---

### Requirement: Generated asset serving with access-policy enforcement

<!-- id: generated-asset.serve.serveGeneratedAsset -->
<!-- entities: GeneratedAsset, User, Organization -->
<!-- enforced: generated-asset.serve.ts:serveGeneratedAsset() -->

Serving a generated asset by publicId SHALL enforce per-asset access_policy: `public` (anyone), `org` (org members), or `user` (creator only). Authorization failure and asset-not-found both return GeneratedAssetNotFoundError (IDOR defense).

#### Scenario: Public asset served

<!-- test: (no existing test found) -->

- **WHEN** asset.accessPolicy="public" and asset.status="ready"
- **THEN** fetch from storage and return body stream with mimeType and sizeBytes

#### Scenario: Org-scoped asset with API key principal

- **WHEN** principal.orgId matches asset.orgId and (no workspaceId constraint or workspaceId matches)
- **THEN** authorize and serve

#### Scenario: Org-scoped asset with session user principal

- **WHEN** principal.userId is present and no principal.orgId; query orgUsers to confirm membership
- **THEN** if found, authorize and serve; else throw GeneratedAssetNotFoundError

#### Scenario: User-scoped asset

- **WHEN** asset.accessPolicy="user" and principal.userId matches asset.userId
- **THEN** authorize and serve

#### Scenario: User-scoped asset; user principal does not match

- **WHEN** principal.userId present but does not equal asset.userId
- **THEN** throw GeneratedAssetNotFoundError (not GeneratedAssetForbiddenError)

#### Scenario: Asset not ready or deleted

- **WHEN** asset.status != "ready" or asset.deletedAt is not null
- **THEN** throw GeneratedAssetNotFoundError

#### Scenario: No identity present for non-public asset

- **WHEN** asset.accessPolicy != "public" and principal has no orgId/userId
- **THEN** throw GeneratedAssetForbiddenError

#### Scenario: Storage object missing

- **WHEN** storage().get() throws StorageNotFoundError
- **THEN** throw GeneratedAssetNotFoundError (asset row present but blob missing)

#### Scenario: Content disposition set by MIME type

- **WHEN** mimeType matches image/_, video/_, or audio/\* (except image/svg+xml)
- **THEN** return contentDisposition="inline"
- **WHEN** any other MIME type
- **THEN** return contentDisposition="attachment"

#### Scenario: Telemetry logged asynchronously

- **WHEN** asset served successfully
- **THEN** fire-and-forget insert to ClickHouse events table with generated_asset.served event type (never blocks response)

---

### Requirement: Asset upload from public URL with SSRF and size protection

<!-- id: asset.upload.assetUploadHandler -->
<!-- entities: Asset -->
<!-- enforced: asset.upload.ts:assetUploadHandler() -->

Asset upload from a public URL SHALL validate SSRF (no private IP ranges, no localhost, no data: schemes), fetch with 10-second timeout, validate content type against asset kind, enforce size limits, and upload to blob storage with a server-controlled key.

#### Scenario: Principal required

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId and ctx.apiKeyId both absent
- **THEN** throw error "Unauthorized: no authenticated principal"

#### Scenario: OrgId required

- **WHEN** ctx.orgId is absent
- **THEN** throw error "Forbidden: orgId is required to upload assets"

#### Scenario: SSRF protection

- **WHEN** sourceUrl supplied
- **THEN** call assertPublicHttpUrl(): reject non-http(s) schemes, reject IP literals in private ranges (0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16, IPv6 loopback/link-local/unique-local), reject hostnames "localhost" and "metadata.google.internal"

#### Scenario: Fetch with timeout

- **WHEN** fetch initiated
- **THEN** set 10-second AbortController timeout; throw if response not ok (HTTP status != 2xx)

#### Scenario: Content type validation

- **WHEN** response received
- **THEN** extract Content-Type header (strip ; charset params); call assertAllowedAssetType(kind, contentType) to validate against ASSET_LIMITS[kind]

#### Scenario: Size limit enforcement

- **WHEN** buffer.byteLength > ASSET_LIMITS[kind]
- **THEN** throw error with limit in bytes and MiB

#### Scenario: Upload to storage

- **WHEN** validation passes
- **THEN** derive server-controlled storage key via deriveAssetKey(kind, orgId, ext); call storage().put() with access="public"; return url, key, contentType, bytes

---

### Invariant: Generated asset access policy always enforced before blob fetch

<!-- entities: GeneratedAsset -->
<!-- enforced: generated-asset.serve.ts:serveGeneratedAsset() -->

All generated asset serving SHALL check the asset's access_policy and principal identity BEFORE calling storage().get(). Authorization failure and asset-not-found both return GeneratedAssetNotFoundError to prevent IDOR.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Generated asset status must be "ready" before serving

<!-- entities: GeneratedAsset -->
<!-- enforced: generated-asset.serve.ts:serveGeneratedAsset() -->

A generated asset MAY only be served when status="ready". Every surviving write path is synchronous and lands `ready` immediately — there is no `pending` async-render state left (ADR-041 removed `createPendingGeneratedAsset` and the render workers that used it).

> Last verified: 2026-06-20 (commit 2f628504); note added 2026-09-07.

---

### Invariant: Storage blob access and DB row insert never drift

<!-- entities: GeneratedAsset -->
<!-- enforced: generated-asset.persist.ts:persistGeneratedAsset() -->

persistGeneratedAsset() uploads to blob storage and inserts the generated_assets row in the same function call (shared seam). Chat stream and attachment-upload calls use withSystemDb (system bypass outside tenant scope) with explicit orgId/workspaceId in args (OXA-1515) to prevent state divergence.

> Last verified: 2026-06-20 (commit 2f628504)

<!-- uncertainty: The exact test coverage for each handler is not tracked by the mined files; test: anchors are inferred from docstring signals only and should be verified against packages/handlers/src/*.test.ts files if they exist. -->
