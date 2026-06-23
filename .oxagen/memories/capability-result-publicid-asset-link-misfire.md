---
name: capability-result-publicid-asset-link-misfire
type: bug
domain: web-app
severity: P2
linear: OXA-1812
date: 2026-06-23
---

**Symptom:** `GET https://app.oxagen.sh/api/v1/assets/agt_ccbpt7mffmqwbtbg1z1sfg` returned the API's raw JSON `{"error":{"code":"not_found","message":"Organization not found"}}`. An AGENT public id (`agt_…`) was being requested through the generated-ASSET serving route; in chat it rendered as a dead deep-link chip on `agent.definition.*` outputs.

**Root cause:** `packages/oxagen/src/capability-meta.ts` → `inferRecordTypeForField()` mapped ANY field named `publicId` to the `asset` record type, and `asset` resolves to route template `/api/v1/assets/{id}`. But `publicId` is a UNIVERSAL id field (agents `agt_…`, conversations `cnv_…`, mcp servers `mcp_…`, …), not asset-specific. The generic `capability-result` chat component (used when a capability declares no curated render hint — `agent.definition.get/create` declare none) therefore turned the agent's `publicId: "agt_…"` into `<a href="/api/v1/assets/agt_…">`. No `generated_assets` row exists for an `agt_` id.

**Why "Organization not found" (the second defect):** In prod the `/api/v1/assets/agt_…` request fell through the Next rewrite (`/api/v1/:path* → ${API}/v1/:path*`) to the org-scoped Hono API mounted at `/v1/:org_slug/:workspace_slug/*`. The org middleware (`apps/api/src/middleware/org.ts:35`) tried to resolve org slug `"assets"` → not found → threw HTTPException(404, "Organization not found"), which `apps/api/src/middleware/error.ts` serialized as `{"error":{"code":"not_found",…}}`. The local Next route `apps/app/src/app/api/v1/assets/[assetId]/route.ts` already maps a missing asset to a clean 404 text response — but the leak only happens when the request reaches the API rewrite (e.g. an env where the local route didn't catch).

**Fix:**
1. `packages/oxagen/src/capability-meta.ts` — `inferRecordTypeForField(field, value?)` now maps `publicId` → `asset` ONLY when the VALUE starts with the generated-asset prefix `gen_` (from `generated_assets` `idMixin("gen")`). Explicit `assetId`/`asset_id` fields stay asset-typed unconditionally. The heuristic scan in `resolveRecordLinks` passes the value so the gate applies.
2. `apps/app/src/app/api/v1/assets/[assetId]/route.ts` — defense-in-depth: the catch maps GeneratedAssetNotFound/Forbidden → 404, and any UNEXPECTED error → a controlled plain-text 500 (`console.error` + `new Response("Internal Server Error", {status:500})`) instead of a bare `throw err`. A `<img>`/`<a>` consumer now never receives an unhandled throw or raw JSON.

**Guard:**
- `packages/oxagen/src/capability-meta.test.ts` — `inferRecordTypeForField("publicId","agt_…")` → null (and `cnv_`, `wrk_`, no-value all → null); `gen_` → asset. `resolveRecordLinks` of an agent-shaped output (`publicId: agt_…`) → `[]`; `gen_…` still links to `/api/v1/assets/gen_…`.
- `packages/handlers/src/generated-asset.serve.test.ts` — an agent-prefixed id with no asset row → clean `GeneratedAssetNotFoundError`.

**Watch-outs:** `/api/v1/assets/{id}` only ever serves a `gen_`-prefixed generated asset. Never link an entity's raw `publicId` to an asset route by field name — gate on the value's prefix or use an explicit `assetId`/`serveUrl`/`url` field. The serve URL for a real asset is built in `packages/handlers/src/generated-asset.persist.ts` as `/api/v1/assets/${row.publicId}` where `row.publicId` is a `gen_` id. Any new entity contract that returns a top-level `publicId` would have hit this same trap before the value-prefix gate.
