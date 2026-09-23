# ADR-154: Restore the marketing ebook lead gate

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform, marketing
- **Related:** ADR-043 (runtime excision, which dropped `cms.*` as collateral),
  `packages/database/src/schema/cms.ts`, `apps/api/src/routes/v1/cms.ts`,
  `apps/web/assets/oxagen.js`, `apps/web/read/index.html`

## Context

ADR-043 excised the agent runtime and, in the same cut, dropped the `cms`
schema: leads, book editions, and one-time access codes that backed the
oxagen.sh field-manual form. That schema was marketing infrastructure, not
agent runtime. The website forms kept posting to `/v1/cms/leads`, so every
submit failed: the route fell under auth (401) and production CORS no longer
admitted the marketing origin for a useful response.

The seed HTML for the book, the access-email template, and the homepage form
all remained. Only the API route, the Postgres schema, and the `/read` gate
page were gone.

## Decision

1. **Restore `cms.*` as a first-party marketing surface.** New Atlas migration
   recreates `cms.leads`, `cms.book_editions`, and `cms.book_access_codes` with
   bypass-only RLS, attribution columns named `created_by_id` / `updated_by_id`
   (ADR-077), and the `message` column on leads from the start.
2. **Mount `/v1/cms` before auth**, same pattern as `/v1/telemetry`: anonymous
   visitors, strict Zod validation, per-IP rate limits.
3. **Restore `/read`** so emailed one-time codes can redeem the book HTML.
4. **Seed book editions from `seedPlatform`**, so every migrate has the gated
   content without a separate manual step.
5. **Keep `MARKETING_URL` required in production** for CORS and for the emailed
   reader links. Without it, oxagen.sh cannot call the API.

This does not reintroduce any agent runtime. The lead gate is a public
marketing capture path that writes non-tenant rows through `withSystemDb`.

## Consequences

- `pnpm db:migrate` recreates the cms schema and seeds both book editions.
- Production must set `MARKETING_URL=https://oxagen.sh` on the API.
- ADR-043's list of dropped schemas no longer includes a permanent ban on
  `cms`; the amendment below records the carve-out.
