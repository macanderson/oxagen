# @oxagen/web-v2 — oxagen.sh website (v2)

Static site deployed as the Vercel project **oxagen-v2-web**. No build step —
Vercel serves this directory as-is (framework preset: Other, root directory
`apps/web`).

## Layout

- `index.html` — the marketing one-pager: the terminal coding agent, the
  platform, a `#field-manual` section with the ebook lead-capture form, and
  the "Get a demo" lead form. Self-contained (inline CSS/JS); fonts load from
  `/fonts/`.
- `read/index.html` — the interactive reader for the ebook *Engineering
  Deterministic AI Coding Agents* (fully self-contained; fonts embedded).
  Serves two editions off one page, picked by `?e=field-manual` or
  `?e=page-flip-reader` (default): the page-flip edition does CSS multi-column
  pagination (each column is a page), 3D leaf-flip on ←/→ keys, running heads
  + folios, typeface/size/ink-mode settings, and chapter-subset PDF export via
  print CSS (`@page 8.5in 11in`, fragmentation-safe). The page gates itself
  behind a single-use `?c=` code minted by the lead-capture API (redeemed via
  `/v1/cms/book/redeem`) rather than a client-side unlock flag; a lead who
  lost their email can request a new one via `/v1/cms/book/resend`.
- `research/deterministic-systems-optimizations-for-ai-agents/author.jpg` —
  the externalized author headshot for the page-flip edition's seed content
  in `packages/database/seed-assets/books/page-flip-reader.html` (Chromium
  mispositions replaced elements in multicol fragments, so the reader swaps
  `<img>` for background-image spans at clone time). `vercel.json` redirects
  the human-facing `/research/deterministic-systems-optimizations-for-ai-agents`
  path itself to `/read?e=page-flip-reader`; there is no `index.html` at that
  path.
- `fonts/` — Aeonik + Aeonik Mono variable fonts (copied from
  `packages/ui/src/styles/fonts/`), plus Literata variable serif
  (normal + italic, latin subset, from Google Fonts) for the book reader —
  all cached immutable for a year.
- `favicon.svg` — the Oxagen hexagon mark.
- `og.png` / `research-assets/book-og.png` — social share cards referenced by
  the Open Graph tags on `index.html` and `read/index.html` respectively.

## Lead capture

Both forms on `index.html` (field-manual gate + get-a-demo), plus the code
redeem/resend calls on `read/index.html`, POST JSON to `{api}/v1/cms/leads`
(and `/v1/cms/book/redeem`, `/v1/cms/book/resend`) — `api.oxagen.sh` in
production, `localhost:4000` when the page is served from localhost. The
endpoint is the public, rate-limited route in `apps/api/src/routes/v1/cms.ts`;
leads land in Postgres per the `cms_ebook_lead_gate` migration. The API's CORS
allowlist must include the marketing origin (`MARKETING_URL`, defaults cover
`https://oxagen.sh`).

The ebook gate is a marketing gate, not access control: form success mints a
single-use `/read?e=...&c=` link server-side and emails it — the reader never
stores an unlock flag client-side.

## Local preview

```bash
cd apps/web && python3 -m http.server 5500
# http://localhost:5500 — the API allows this origin in non-production
```

## History

The previous interim homepage (July 2026 platform health & investor deck)
was replaced by this marketing site; it cited internal audit findings and was
never meant for a public domain. Recover it from git history if needed.
