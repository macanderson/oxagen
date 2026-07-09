# @oxagen/web-v2 — oxagen.sh website (v2)

Static site deployed as the Vercel project **oxagen-v2-web**. No build step —
Vercel serves this directory as-is (framework preset: Other, root directory
`apps/web`).

## Layout

- `index.html` — the marketing one-pager: the terminal coding agent, the
  platform, a gated field-manual download, and the "Get a demo" lead form.
  Self-contained (inline CSS/JS); fonts load from `/fonts/`.
- `field-manual/index.html` — the interactive ebook *Engineering Deterministic
  AI Coding Agents* (fully self-contained; fonts embedded). A small script at
  the top gates it behind the lead form on `/#field-manual`.
- `field-manual/engineering-deterministic-ai-coding-agents.epub` — EPUB
  download, served with `Content-Disposition: attachment` (see `vercel.json`).
- `research/deterministic-systems-optimizations-for-ai-agents/index.html` —
  the page-flip **book reader** edition of the same manual (ungated). CSS
  multi-column pagination (each column is a page), 3D leaf-flip on ←/→ keys,
  running heads + folios, typeface/size/ink-mode settings, and chapter-subset
  PDF export via print CSS (`@page 8.5in 11in`, fragmentation-safe). Content
  is baked in at build time from the field-manual source; the sibling
  `author.jpg` is the externalized headshot (Chromium mispositions replaced
  elements in multicol fragments, so the reader swaps `<img>` for
  background-image spans at clone time).
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

## History

The previous interim homepage (July 2026 platform health & investor deck)
was replaced by this marketing site; it cited internal audit findings and was
never meant for a public domain. Recover it from git history if needed.
