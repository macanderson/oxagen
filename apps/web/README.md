# @oxagen/web-v2 — oxagen.sh website (v2)

Static site deployed as the Vercel project **oxagen-v2-web**. No build step —
Vercel serves this directory as-is (framework preset: Other, root directory
`apps/web`).

## Layout

- `assets/oxagen.css` — the shared shell: the Stella colour tokens, the nav,
  buttons, cards, terminal chrome, forms and footer. Every page under
  `index.html` and `products/` links it. Each page adds its own small
  `<style>` block for the parts only that page has (its hero, mostly).
- `assets/oxagen.js` — the shared behaviour for those same pages: nav state,
  the products dropdown, the mobile drawer, reveal-on-scroll, the typewriters
  and terminal replay, the `[data-count]` counters, the `[data-tabs]` deck,
  the copy buttons, and the lead forms. Plain JavaScript, no dependencies, no
  build step. Every animation that would otherwise run forever (typewriters,
  terminal replay) is started and stopped by an IntersectionObserver, so a
  page of them costs nothing below the fold.
- `assets/tui/*.svg` — the ten Stella deck renderings used as screenshots.
- `index.html` — the marketing one-pager: a three-card `#products` strip, the
  terminal coding agent, the platform, a `#field-manual` section with the
  ebook lead-capture form, and the "Get a demo" lead form.
- `products/stella/`, `products/oxagen/`, `products/private-llms/` — one page
  per product. Each carries its own copy of the nav, drawer and footer markup.
- `read/index.html` — the gate in front of the ebook *Engineering
  Deterministic AI Coding Agents*. The page itself holds no book text. It
  takes a single-use `?c=` code, posts it to `/v1/cms/book/redeem`, and
  replaces itself with the reader HTML the API returns; the reader for each
  edition is seeded content in `packages/database/seed-assets/books/`. With
  no code, it shows the lead form instead, and `?e=field-manual` or
  `?e=page-flip-reader` (default) picks which edition to ask for. A lead who
  lost their email can request a new link via `/v1/cms/book/resend`.
- `research/deterministic-systems-optimizations-for-ai-agents/author.jpg` —
  the author headshot the page-flip edition loads. It lives here rather than
  inside the seed HTML because Chromium misplaces images inside multi-column
  fragments, so the reader swaps each `<img>` for a background-image span when
  it clones a page. `vercel.json` redirects the human-facing
  `/research/deterministic-systems-optimizations-for-ai-agents` path to
  `/read?e=page-flip-reader`; there is no `index.html` at that path.
- `fonts/` — Aeonik + Aeonik Mono variable fonts (copied from
  `packages/ui/src/styles/fonts/`), plus Literata variable serif
  (normal + italic, latin subset, from Google Fonts) for the book reader —
  all cached immutable for a year.
- `favicon.svg` — the Oxagen hexagon mark.
- `og.png` / `research-assets/book-og.png` — social share cards referenced by
  the Open Graph tags on `index.html` and `read/index.html` respectively.
- `overview-video.html` — a standalone Stella overview page. Nothing on the
  site links to it and it is not in `sitemap.xml`; it is reachable only if you
  already know the URL.

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

The forms still post to `localhost:4000`, so run the API too if you want to
submit one.
