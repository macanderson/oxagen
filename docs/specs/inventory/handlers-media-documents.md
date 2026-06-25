# Spec: handlers-media-documents

> Auto-extracted by spec-miner. Last mined: 2026-06-20.
> Source: image.generate, image.create, image.analyze, image.list, video.generate, svg.generate, markdown.generate, mermaid.generate, asset.upload, generated-asset.persist, generated-asset.serve, document.create, document.read, document.list, documents.generate, documents.pdf.create, form.fill, archive.create
> Last verified: 2026-06-20 (commit 2f628504)

---

### Requirement: Image generation returns placeholder when AI Gateway key absent

<!-- id: image.generate.imageGenerateHandler -->
<!-- entities: GeneratedAsset -->
<!-- enforced: image.generate.ts:imageGenerateHandler() -->

When AI_GATEWAY_API_KEY is not configured or fails Zod validation, image generation SHALL return a typed placeholder object without throwing. The placeholder includes alt text (derived from prompt or caller-supplied), `placeholder: true`, and a render directive with the image-preview component.

#### Scenario: AI_GATEWAY_API_KEY not configured

<!-- test: (no existing test found) -->

- **WHEN** requireEnv(["AI_GATEWAY_API_KEY"]) throws or returns empty value
- **THEN** return object with `placeholder: true`, `alt` text, and `render.componentId: "image-preview"`

#### Scenario: AI_GATEWAY_API_KEY is configured

- **WHEN** AI_GATEWAY_API_KEY is valid and selectImageModel() succeeds
- **THEN** call generateImageFor(), encode base64 response as data URI, return object with `placeholder: false` and `dataUri`

#### Scenario: Image generation fails

- **WHEN** generateImageFor() throws an error
- **THEN** return placeholder with `placeholder: true` and error reason in render props, never throw

---

### Requirement: Image creation persists asset to blob and database

<!-- id: image.create.imageCreateHandler -->
<!-- entities: GeneratedAsset, User -->
<!-- enforced: image.create.ts:imageCreateHandler() -->
<!-- triggers: Generated asset becomes available for serving -->

When an authenticated user creates an image from a prompt, the handler SHALL generate the image via the Vercel AI Gateway, persist bytes to blob storage with Vercel Blob driver, insert a generated_assets row with status `ready`, and return the public asset id and access-controlled serving URL.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "image.create requires an authenticated user"

#### Scenario: Prompt enhancement enabled

- **WHEN** workspace prompt config has autoImprovePrompts enabled (default true)
- **THEN** call enhancePromptIfInsufficient() before image generation; use enhanced prompt for generateImageFor()

#### Scenario: Image persisted successfully

- **WHEN** generateImageFor() returns base64-encoded image bytes
- **THEN** call persistGeneratedAsset() with kind="image", accessPolicy="org", bytes decoded from base64; return `image_id` (publicId), `url`, `created_at`

#### Scenario: Generation fails or returns no bytes

- **WHEN** generateImageFor() fails or returns no image data
- **THEN** return placeholder URL (placehold.co/1024x1024) with placeholder image_id and current timestamp, never persist

#### Scenario: Model mapping

- **WHEN** input.model is "gpt-image-1" or "flux-2-max"
- **THEN** map to gateway model id via MODEL_ID_MAP; default to "openai/gpt-image-1" if unmapped

---

### Requirement: Video generation enqueues async render and returns pending asset URL

<!-- id: video.generate.videoGenerateHandler -->
<!-- entities: GeneratedAsset, User -->
<!-- depends_on: Pending generated asset creation -->
<!-- triggers: agent/video.render Inngest event -->
<!-- enforced: video.generate.ts:videoGenerateHandler() -->

When an authenticated user requests video generation, the handler SHALL validate AI_GATEWAY_API_KEY presence, create a pending generated_assets row with status `pending`, dispatch an async `agent/video.render` event to Inngest, and return the queued status with a stable serving URL.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "video.generate requires an authenticated user"

#### Scenario: AI_GATEWAY_API_KEY missing

- **WHEN** requireEnv(["AI_GATEWAY_API_KEY"]) fails or key is empty
- **THEN** throw error "video.generate: AI_GATEWAY_API_KEY is not configured — video generation is unavailable"

#### Scenario: Pending asset created and job queued

- **WHEN** validation passes
- **THEN** call createPendingGeneratedAsset() with kind="video", status="pending"; dispatch eventClient event "agent/video.render" with assetId, prompt, model, mediaTier; return `status: "queued"`, `jobId` (publicId), `serveUrl`

#### Scenario: Optional video parameters passed to worker

- **WHEN** input.durationSeconds or input.aspectRatio are provided
- **THEN** include them in the Inngest event payload

---

### Requirement: Generated asset persisted with dual storage (blob + database)

<!-- id: generated-asset.persist.persistGeneratedAsset -->
<!-- entities: GeneratedAsset, StorageProvider -->
<!-- enforced: generated-asset.persist.ts:persistGeneratedAsset() -->

When media bytes are persisted, they SHALL be uploaded to blob storage with a deterministic key, then a generated_assets row inserted with status `ready`, MIME type, size, storage metadata, and access policy. The storage seam is shared across all generation paths (chat, API, Inngest workers).

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

### Requirement: Pending asset creation for async render workflows

<!-- id: generated-asset.persist.createPendingGeneratedAsset -->
<!-- entities: GeneratedAsset -->
<!-- enforced: generated-asset.persist.ts:createPendingGeneratedAsset() -->

When an async render (e.g., video) is queued, a generated_assets row SHALL be inserted with status `pending`, empty storageKey, and null storageUrl/sizeBytes. The serving URL returned is stable; serving route returns 404 until the async worker updates the row to `ready`.

#### Scenario: Pending row created

<!-- test: (no existing test found) -->

- **WHEN** createPendingGeneratedAsset() is called
- **THEN** insert generated_assets row with status="pending", storageKey="", storageUrl=null, sizeBytes=null; return publicId and serveUrl

#### Scenario: Serving returns 404 until ready

- **WHEN** serveGeneratedAsset() called for a pending asset
- **THEN** serveUrl `/api/v1/assets/{publicId}` returns 404 until async worker updates row to status="ready"

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

### Requirement: SVG generation with LLM and sanitization

<!-- id: svg.generate.svgGenerateHandler -->
<!-- entities: GeneratedAsset -->
<!-- enforced: svg.generate.ts:svgGenerateHandler() -->

SVG generation SHALL call the LLM via generateObjectFor() to produce valid SVG markup, sanitize the output to remove script tags and event handlers, and return inline-renderable markup. Generation failure returns placeholder SVG without throwing.

#### Scenario: Prompt enhancement enabled

<!-- test: (no existing test found) -->

- **WHEN** workspace autoImprovePrompts is true (default)
- **THEN** call enhancePromptIfInsufficient() before generateObjectFor()

#### Scenario: System prompt resolved from registry

- **WHEN** loadWorkspacePromptConfig() succeeds
- **THEN** use resolvePrompt() to build system prompt from baseline + workspace customizations + additional instructions

#### Scenario: Model generates SVG

- **WHEN** generateObjectFor() returns object with svg and title
- **THEN** sanitize raw SVG: remove <script>…</script>, remove <script />, remove on\* event handlers, remove javascript: URLs

#### Scenario: Model error

- **WHEN** generateObjectFor() throws
- **THEN** return minimal placeholder SVG with border and error text; return title from input or "Generation failed"

#### Scenario: SVG markup requirements

- **WHEN** LLM generates SVG
- **THEN** enforce in schema: must be valid SVG (open with <svg, close with </svg>), use currentColor for theme adaptation, use CSS custom properties for brand colors, animations via <animate> or <style> @keyframes encouraged, no <script> or on\* handlers

---

### Requirement: Markdown generation with structured or raw fallback

<!-- id: markdown.generate.markdownGenerateHandler -->
<!-- entities: GeneratedAsset, User -->
<!-- enforced: markdown.generate.ts:markdownGenerateHandler() -->

Markdown generation SHALL encode a markdown source (raw, structured sections, or title-only fallback) to UTF-8 bytes, persist via persistGeneratedAsset() with kind="document", and return file attachment metadata. User identity required.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "markdown.generate: userId is required — no user identity in context"

#### Scenario: Raw markdown supplied

- **WHEN** input.markdown is non-null
- **THEN** use raw markdown source as-is

#### Scenario: Structured sections supplied

- **WHEN** input.markdown is null and input.sections is non-empty
- **THEN** assemble markdown from title (H1) + sections (H2 headings + paragraphs)

#### Scenario: Title-only fallback

- **WHEN** input.markdown and input.sections are null or empty
- **THEN** use single H1 title line

#### Scenario: Asset persisted with metadata

- **WHEN** markdown bytes encoded and persistGeneratedAsset() called
- **THEN** use kind="document", mimeType="text/markdown", prompt=`Generate markdown: ${title}`, model="local"; return publicId, serveUrl, render directive with kind="markdown"

---

### Requirement: Mermaid diagram validation and passthrough render

<!-- id: mermaid.generate.mermaidGenerateHandler -->
<!-- entities: User -->
<!-- enforced: mermaid.generate.ts:mermaidGenerateHandler() -->

Mermaid diagram generation SHALL validate the diagram source (non-empty, under 50,000 characters), accept a theme parameter, and return the source and title for client-side rendering. No server-side rendering or persistence.

#### Scenario: Diagram source validation

<!-- test: (no existing test found) -->

- **WHEN** input.diagram is empty or blank
- **THEN** throw error "mermaid.generate: diagram source must not be blank"

#### Scenario: Diagram source length limit

- **WHEN** input.diagram.length > 50,000
- **THEN** throw error "mermaid.generate: diagram source exceeds the 50,000-character cap"

#### Scenario: Render directive returned

- **WHEN** validation passes
- **THEN** return object with title, source, and render directive with componentId="mermaid-diagram"; theme defaults to "default"

---

### Requirement: Document DOCX/XLSX/PPTX generation from structured content

<!-- id: documents.generate.documentsGenerateHandler -->
<!-- entities: GeneratedAsset, User -->
<!-- enforced: documents.generate.ts:documentsGenerateHandler() -->

Document generation from structured sections SHALL encode to DOCX (docx library), XLSX (exceljs), or PPTX (pptxgenjs), persist via persistGeneratedAsset() with the appropriate MIME type and kind, and return file attachment metadata. User identity required.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "documents.generate: userId is required — no user identity in context"

#### Scenario: DOCX encoding

- **WHEN** input.kind="document"
- **THEN** call buildDocx(): create Document with title as H1, optionally iterate sections and add H1 headings + paragraphs; return Uint8Array via Packer.toBuffer()

#### Scenario: XLSX encoding

- **WHEN** input.kind="spreadsheet"
- **THEN** call buildXlsx(): create Workbook, add worksheet (title truncated to 31 chars per Excel limit), add header row with bold formatting, add data rows from content.rows

#### Scenario: PPTX encoding

- **WHEN** input.kind="presentation"
- **THEN** call buildPptx(): create presentation, add one slide per section with title and bullet points; return Uint8Array from base64-decoded output

#### Scenario: Encoding failure

- **WHEN** buildDocx/buildXlsx/buildPptx throws
- **THEN** log error and re-throw (no placeholder)

#### Scenario: Asset persisted with metadata

- **WHEN** encoding succeeds
- **THEN** call persistGeneratedAsset() with kind="document"/"spreadsheet"/"presentation", MIME per type, prompt=`Generate {kind}: {title}`, model="local"; return publicId, serveUrl, render directive with file-attachment component

---

### Requirement: PDF generation from structured content with layout

<!-- id: documents.pdf.create.documentsPdfCreateHandler -->
<!-- entities: GeneratedAsset, User -->
<!-- enforced: documents.pdf.create.ts:documentsPdfCreateHandler() -->

PDF generation SHALL accept title and structured sections, lay out text with font sizing/spacing, handle page overflow, and persist the PDF bytes via persistGeneratedAsset(). User identity required.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "documents.pdf.create: userId is required — no user identity in context"

#### Scenario: PDF layout

- **WHEN** buildPdf() called
- **THEN** create A4 page (595.28 x 841.89 points), set title with font size 24 bold, iterate sections and draw headings (font 16) + body paragraphs (font 11); add new page when y cursor would overflow bottom margin (72-point margin)

#### Scenario: Text wrapping

- **WHEN** text exceeds content width
- **THEN** wrap using approximation: approxCharWidth = fontSize \* 0.55, split on word boundaries, avoid orphaned words

#### Scenario: PDF metadata

- **WHEN** PDF created
- **THEN** embed Helvetica and Helvetica-Bold fonts, set PDF title, creator="Oxagen", creation date

#### Scenario: Asset persisted

- **WHEN** buildPdf() succeeds
- **THEN** call persistGeneratedAsset() with kind="pdf", mimeType="application/pdf", prompt=`Generate PDF: {title}`, model="local"; return publicId, serveUrl, render directive with filename=`{title}.pdf`

---

### Requirement: Form fill with LLM-assisted field value suggestion

<!-- id: form.fill.formFillHandler -->
<!-- entities: Form -->
<!-- enforced: form.fill.ts:formFillHandler() -->

Form fill SHALL build a Zod schema from field specifications (text, number, boolean, select), construct a system prompt directing the LLM to fill unchanged fields conservatively, call generateObjectFor(), compute per-field diffs, and return proposed values with change reasons. Model errors degrade gracefully to unchanged fields.

#### Scenario: Schema building

<!-- test: (no existing test found) -->

- **WHEN** input.fields supplied
- **THEN** build Zod schema where each field maps to appropriate type (select=z.enum, number=z.number().nullable(), boolean=z.boolean().nullable(), text/textarea=z.string().nullable()); add `{fieldName}__reason` (nullable string) for each field

#### Scenario: System prompt construction

- **WHEN** systemPrompt built
- **THEN** include field specs (name, type, options, required, current value), context (route, entitySummary), and rules: only change fields the instruction implies, provide per-field reason (changed: 1-sentence explanation; unchanged: null), never invent values, select values must be from options, return correct primitive types

#### Scenario: LLM call

- **WHEN** generateObjectFor() invoked with schema and system prompt
- **THEN** use temperature=0, telemetry includes messageId (fallback to requestId)

#### Scenario: Model error

- **WHEN** generateObjectFor() throws
- **THEN** return all fields unchanged with reason="Model error — field left unchanged.", never throw

#### Scenario: Diff computation

- **WHEN** modelObject returned
- **THEN** for each field compare proposed (from model) to current (from input) using strict equality; changed=true if different; extract per-field reason (nullable string)

#### Scenario: Result structure

- **WHEN** processing complete
- **THEN** return array of field diffs with name, current, proposed, changed, optional reason

---

### Requirement: Document creation with content

<!-- id: document.create.documentCreateHandler -->
<!-- entities: Document, User -->
<!-- enforced: document.create.ts:documentCreateHandler() -->

Document creation SHALL require workspace and user context, insert a documents row with title and optional content, and return the public id and creation timestamp.

#### Scenario: Workspace required

<!-- test: (no existing test found) -->

- **WHEN** ctx.workspaceId is absent
- **THEN** throw error "document.create requires a workspace scope"

#### Scenario: User required

- **WHEN** ctx.userId is absent
- **THEN** throw error "document.create requires an authenticated user"

#### Scenario: Document inserted

- **WHEN** validation passes
- **THEN** insert into documents with title, content (input.content ?? ""), createdByUserId, updatedByUserId; return publicId, title, createdAt, workspace_id

---

### Requirement: Document read with workspace scope

<!-- id: document.read.documentReadHandler -->
<!-- entities: Document -->
<!-- enforced: document.read.ts:documentReadHandler() -->

Document read SHALL require workspace context, resolve the document by public id within the workspace, and return title, content, metadata, and creation timestamp.

#### Scenario: Workspace required

<!-- test: (no existing test found) -->

- **WHEN** ctx.workspaceId is absent
- **THEN** throw error "document.read requires a workspace scope"

#### Scenario: Document lookup

- **WHEN** document.read called with document_id
- **THEN** query documents where publicId=input.document_id AND workspaceId=ctx.workspaceId AND deletedAt IS NULL

#### Scenario: Document not found

- **WHEN** lookup returns no row
- **THEN** throw error `document.read: document "{document_id}" not found`

#### Scenario: Document returned

- **WHEN** document found
- **THEN** return title, content, metadata (as JSON object or {}), created_at

---

### Requirement: Document list with workspace scope and newest-first ordering

<!-- id: document.list.documentListHandler -->
<!-- entities: Document, User -->
<!-- enforced: document.list.ts:documentListHandler() -->

Document list SHALL require workspace context, query documents in the workspace ordered newest-first, and return array of document summaries with id, title, timestamps, and author userId.

#### Scenario: Workspace required

<!-- test: (no existing test found) -->

- **WHEN** ctx.workspaceId is absent
- **THEN** throw error "document.list requires a workspace scope"

#### Scenario: Query and ordering

- **WHEN** document.list called
- **THEN** query documents where workspaceId=ctx.workspaceId AND deletedAt IS NULL; order by createdAt DESC

#### Scenario: Result structure

- **WHEN** documents found
- **THEN** return array with id (publicId), title, created_at, updated_at, author (createdByUserId or "unknown")

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

### Requirement: Archive creation from multiple entry sources

<!-- id: archive.create.archiveCreateHandler -->
<!-- entities: GeneratedAsset, Archive -->
<!-- enforced: archive.create.ts:archiveCreateHandler() -->

Archive creation SHALL accept entries sourced from existing generated assets, base64-encoded blobs, or text; resolve each entry to bytes in parallel; build a ZIP with fflate; and persist via persistGeneratedAsset(). User identity required.

#### Scenario: User not authenticated

<!-- test: (no existing test found) -->

- **WHEN** ctx.userId is absent
- **THEN** throw error "archive.create: userId is required — no user identity in context"

#### Scenario: Entry resolution from assetId

- **WHEN** entry.assetId provided
- **THEN** query generatedAssets for publicId, fetch from storage by storageKey, collect ReadableStream into Uint8Array; validate asset.orgId matches caller's orgId, asset.status="ready", asset.deletedAt IS NULL

#### Scenario: Entry resolution from base64

- **WHEN** entry.contentBase64 provided (and no assetId)
- **THEN** decode base64 to binary, return Uint8Array

#### Scenario: Entry resolution from text

- **WHEN** entry.text provided (and no assetId/contentBase64)
- **THEN** encode text to UTF-8 via TextEncoder

#### Scenario: Entry validation

- **WHEN** entry has no assetId, contentBase64, or text
- **THEN** throw error `archive.create: entry "{name}" must supply assetId, contentBase64, or text`

#### Scenario: Parallel resolution

- **WHEN** multiple entries provided
- **THEN** resolve all entries in parallel via Promise.all(); fail fast on first error

#### Scenario: ZIP creation

- **WHEN** all entries resolved
- **THEN** call zipSync(zipInput, { level: 6 }) to create compressed archive; return Uint8Array

#### Scenario: Asset persisted

- **WHEN** ZIP built
- **THEN** call persistGeneratedAsset() with kind="archive", mimeType="application/zip", prompt=`Create archive: {archiveName}`, model="local"; return publicId, serveUrl, render directive with filename=`{archiveName}.zip`

---

### Requirement: Image list with workspace scope and newest-first ordering

<!-- id: image.list.imageListHandler -->
<!-- entities: GeneratedAsset -->
<!-- enforced: image.list.ts:imageListHandler() -->

Image list SHALL query workspace generated_assets filtered to kind="image", status="ready", not deleted, ordered newest-first, and return array of image metadata.

#### Scenario: Image query

<!-- test: (no existing test found) -->

- **WHEN** image.list called
- **THEN** query generatedAssets where kind="image" AND workspaceId=ctx.workspaceId AND status="ready" AND deletedAt IS NULL; order by createdAt DESC

#### Scenario: Result structure

- **WHEN** query completes
- **THEN** return array with id (publicId), url (storageUrl or fallback to `/api/v1/assets/{publicId}`), created_at, prompt

---

### Requirement: Image analysis via multimodal LLM

<!-- id: image.analyze.imageAnalyzeHandler -->
<!-- entities: GeneratedAsset -->
<!-- enforced: image.analyze.ts:imageAnalyzeHandler() -->

Image analysis SHALL resolve a generated asset within the workspace, build a multimodal message with the asset URL, call generateObjectFor() with an overridable prompt, and return structured analysis (analysis string, tags array, description).

#### Scenario: Asset lookup

<!-- test: (no existing test found) -->

- **WHEN** image.analyze called with image_id
- **THEN** query generatedAssets where publicId=input.image_id AND workspaceId=ctx.workspaceId AND status="ready" AND deletedAt IS NULL

#### Scenario: Asset not found or not ready

- **WHEN** lookup returns no row or asset.status != "ready"
- **THEN** throw error `Asset {image_id} not found or not ready`

#### Scenario: Prompt resolution

- **WHEN** asset found
- **THEN** load workspace prompt config (best-effort); resolve "image.analyze" system prompt via resolvePrompt() with baseline imageAnalyzePrompt() + workspace customizations

#### Scenario: Multimodal message construction

- **WHEN** asset and instruction resolved
- **THEN** build ModelMessage with role="user", content=[{type: "image", image: storageUrl, mediaType}, {type: "text", text: instruction}]

#### Scenario: LLM analysis

- **WHEN** message ready
- **THEN** call generateObjectFor() with analysisSchema (analysis: string, tags: string[], description: string); use selectModel(); include telemetry

#### Scenario: Result returned

- **WHEN** analysis complete
- **THEN** return object with analysis, tags, description

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

A generated asset MAY only be served when status="ready". Assets in "pending" state (async renders not yet complete) return GeneratedAssetNotFoundError.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: All media generation routes through single telemetry/billing chokepoint

<!-- entities: GeneratedAsset -->
<!-- enforced: image.generate.ts, image.create.ts, markdown.generate.ts, documents.generate.ts, documents.pdf.create.ts, archive.create.ts -->

Image and SVG generation routes exclusively through generateImageFor(), document/PDF/markdown generation calls persistGeneratedAsset() (single seam), video generation enqueues via eventClient (Inngest), and form.fill calls generateObjectFor(). All paths emit telemetry (duration_ms, surface, provider, model, token counts) and charge credits via billing gate.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: User identity required for asset persistence

<!-- entities: GeneratedAsset, User -->
<!-- enforced: image.create.ts, video.generate.ts, documents.generate.ts, documents.pdf.create.ts, markdown.generate.ts, archive.create.ts -->

Asset persistence (persistGeneratedAsset) requires ctx.userId. API-key-only calls (no session user) cannot own user-scoped assets and must be rejected at the handler boundary.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Workspace scope required for document and form operations

<!-- entities: Document -->
<!-- enforced: document.create.ts, document.read.ts, document.list.ts -->

All document handlers require ctx.workspaceId. Queries always filter by workspaceId and use withTenantDb (RLS tenant scope) to prevent cross-workspace leakage.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Storage blob access and DB row insert never drift

<!-- entities: GeneratedAsset -->
<!-- enforced: generated-asset.persist.ts:persistGeneratedAsset() -->

persistGeneratedAsset() uploads to blob storage and inserts the generated_assets row in the same function call (shared seam). Chat stream calls use withSystemDb (system bypass outside tenant scope) with explicit orgId/workspaceId in args (OXA-1515) to prevent state divergence.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: SVG never persisted as blob; rendered inline

<!-- entities: GeneratedAsset -->
<!-- enforced: svg.generate.ts -->

SVG generation returns markup as a string in the response (not as a stored blob). The svg-preview component renders via `<img src="data:image/svg+xml,...">`, never dangerouslySetInnerHTML. SVG is sanitized server-side (script/event-handler removal) as defence-in-depth.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Mermaid diagram never persisted; rendered client-side

<!-- entities: Diagram -->
<!-- enforced: mermaid.generate.ts -->

Mermaid diagram generation validates source and returns it with title and theme for client-side rendering. No blob storage, no database persistence, no server-side rendering.

> Last verified: 2026-06-20 (commit 2f628504)

---

### Invariant: Form fields type-safe via Zod schema in fill operation

<!-- entities: Form -->
<!-- enforced: form.fill.ts -->

Form fill dynamically builds a Zod schema from field specifications (select=enum, number=nullable number, boolean=nullable boolean, text=nullable string). The model must conform to this schema; violations are caught before diff computation.

> Last verified: 2026-06-20 (commit 2f628504)

---

<!-- uncertainty: The exact test coverage for each handler is not tracked by the mined files; test: anchors are inferred from docstring signals only and should be verified against packages/handlers/src/*.test.ts files if they exist. -->
