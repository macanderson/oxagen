---
name: capability-result-heuristic-record-links-fragile
type: observation
domain: web-app
severity: P2
linear: OXA-1812
date: 2026-06-23
---

**Observation:** The generic `capability-result` chat-render path (`packages/oxagen/src/capability-meta.ts`) infers deep-links from output field NAMES via `inferRecordTypeForField` whenever a capability declares no curated render hint. This name-based heuristic is fragile and error-prone: it over-claims on generic field names. `publicId` collided with the asset route for every entity capability that returns a top-level `publicId` (agents, conversations, mcp servers …) — see [[capability-result-publicid-asset-link-misfire]].

**Why it's a recurring footgun:**

- The router maps a record type → a literal route template (`RECORD_LINK_ROUTES`), and `asset → /api/v1/assets/{id}` is the only template that does NOT require slugs, so it silently "resolves" for any id value regardless of whether that id is a real asset.
- The only safety net downstream is `safeHref()` in `capability-result.tsx`, which validates the URL SCHEME, not whether the record-type inference was correct. A scheme-valid but semantically-wrong link passes straight through.
- Capabilities that DO declare a curated `render` hint with explicit `recordLinks` (graph.node.\*, conversation.list, …) are safe; the bare-fallback capabilities are the exposed surface.

**Guidance for future field-name heuristics:**

- Prefer EXPLICIT `recordLinks` specs in `CURATED_RENDER_HINTS` (or contract `render`) over relying on the heuristic fallback for any capability whose output should deep-link.
- When a heuristic must match a generic/ambiguous field name (`publicId`, `id`), gate on the VALUE's id-prefix, not the field name alone. Generated assets are `gen_`; agents `agt_`; conversations `cnv_`; workspaces `wrk_`; mcp `mcp_` (prefixes come from `idMixin("…")` in `packages/database/src/schema/*`).
- `/api/v1/assets/{id}` serves ONLY `gen_`-prefixed generated assets. It is consumed by `<img src>`/`<a href>`, so a wrong id there surfaces a broken image or — if it falls through the Next `/api/v1/:path*` rewrite to the org-scoped Hono API — raw `{"error":…}` JSON.
