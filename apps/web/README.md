# @oxagen/web-v2 — oxagen.sh website (v2)

Static site deployed as the Vercel project **oxagen-v2-web**. No build step —
Vercel serves this directory as-is (framework preset: Other, root directory
`apps/web`).

## Layout

- `index.html` — the marketing one-pager: the governed boundary, the control
  plane, a gated field-manual download, and the "Get a demo" lead form.
  Self-contained (inline CSS/JS); fonts load from `/fonts/`.
- `read/index.html` — the page-flip **book reader** edition of *Engineering
  Deterministic AI Coding Agents* (fully self-contained; fonts embedded). CSS
  multi-column pagination (each column is a page), 3D leaf-flip on ←/→ keys,
  running heads + folios, typeface/size/ink-mode settings, and chapter-subset
  PDF export via print CSS (`@page 8.5in 11in`, fragmentation-safe).
  `research/deterministic-systems-optimizations-for-ai-agents/author.jpg` is
  the externalized headshot (Chromium mispositions replaced elements in
  multicol fragments, so the reader swaps `<img>` for background-image spans
  at clone time). `vercel.json` redirects the older `/field-manual` and
  `/research/...` URLs here.
- `fonts/` — Aeonik + Aeonik Mono variable fonts (copied from
  `packages/ui/src/styles/fonts/`), plus Literata variable serif
  (normal + italic, latin subset, from Google Fonts) for the book reader —
  all cached immutable for a year.
- `favicon.svg` — the Oxagen hexagon mark.
- `og.png` — social share card referenced by the Open Graph tags.

## Lead capture

Both forms (field-manual gate + get-a-demo) POST JSON to
`POST {api}/v1/marketing/leads` — `api.oxagen.sh` in production,
`localhost:4000` when the page is served from localhost. The endpoint is the
public, rate-limited route in `apps/api/src/routes/v1/marketing.lead.ts`;
leads land in the Postgres `marketing.leads` table. The API's CORS allowlist
must include the marketing origin (`MARKETING_URL`, defaults cover
`https://oxagen.sh`).

The ebook gate is a marketing gate, not access control: form success sets
`localStorage.ox_fm_unlocked` and the reader fails open on storage errors.

## Local preview

```bash
cd apps/web && python3 -m http.server 5500
# http://localhost:5500 — the API allows this origin in non-production
```
