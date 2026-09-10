# @oxagen/web-v2 — oxagen.sh website (v2)

Hand-authored static pages plus a blog compiled from MDX. `pnpm build` (from
the repo root, or `pnpm --filter @oxagen/web-v2 build`) assembles the
publishable site into `dist/`: every static file here except source, config
and tooling, plus the generated `blog/` tree and a `sitemap.xml` that includes
it. CI's `deploy-web` job builds and syncs `dist/` to the S3 bucket behind
CloudFront; `vercel.json` points the Vercel project (**oxagen-v2-web**, root
directory `apps/web`) at the same build command and output directory. Nothing
in `dist/` is committed.

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
- `fonts/` — Space Grotesk at 400/500/600/700 (the house typeface, vendored
  from the brand kit by `node tools/scripts/sync-brand-assets.mjs`), plus
  Literata variable serif (normal + italic, latin subset) which only the book
  reader offers as a long-form reading option — all cached immutable for a
  year. The Aeonik binaries this replaced were removed with the house system;
  Space Grotesk is what the wordmarks are cut from, so the running text and the
  logo are the same design.
- `favicon.svg` — the house `Ox` lettermark: the word's own first two letters
  in Space Grotesk, ONE colour, adaptive to the tab's colour scheme. It is
  never the wordmark and never a lockup, and it never carries the gold — the
  metal belongs to the `x` of the word.
- `og.png` / `research-assets/book-og.png` — social share cards referenced by
  the Open Graph tags on `index.html` and `read/index.html` respectively.
- `content/` — the blog's source of truth. See **The blog** below.
- `scripts/build.mjs` — the build: copies the site, compiles the blog, writes
  the feed and sitemap. `scripts/lib/` holds the pure pieces (`content.mjs`
  for loading and validation, `mdx.mjs` for MDX → HTML, `html.mjs` for the
  page templates), each with a co-located vitest suite gated at 90% coverage.
  `scripts/check-links.mjs` fetches every URL cited in the posts and fails on
  any that does not resolve (`pnpm --filter @oxagen/web-v2 check:links`); it
  is network-bound, so it is a separate command rather than part of `build`.
- `assets/blog.css` — the blog's own rules (index, pillar and post layouts,
  the reading measure, references, callouts). Semantic tokens only, same four
  rules as `oxagen.css`.
- `assets/blog/pillars/*.jpg` — one stock hero per pillar, 1600px wide, with
  the photographer credit kept in `content/pillars.yaml` (the Unsplash
  License asks for it and the pages print it).
- `overview-video.html` — a standalone Stella overview page. Nothing on the
  site links to it and it is not in `sitemap.xml`; it is reachable only if you
  already know the URL.

## The palette, and the four rules

`assets/oxagen.css` holds the palette in **two layers**, and the split is the
whole discipline:

- **Primitives** — the `--st-*` table, the house palette byte-for-byte from
  `tokens/house-tokens.css` in the brand kit. This is the only place in the
  site a hex may appear.
- **Semantics** — `--ground`, `--gold`, `--ink-3` and the rest, each aliasing a
  primitive. Rules and pages name these.

Reskinning means repointing an alias. It never means re-hexing a primitive, and
it never means writing a colour into a rule or a page.

The same table is what `assets/tui/*.svg` is drawn in, which is the point: the
product screenshots and the page around them are one surface. Gold (`--gold`,
`#D6962C`) is identity and at most one action per screen, never a state and
never a surface; `--pass` and `--fail` carry state.

Four rules hold the look together. Breaking one is a review question, not a
matter of taste:

1. **No gradients.** Not in CSS, not in the wordmark, not in the favicon. The
   `--tex-*` textures are hard-stop repeating patterns, which read as texture
   rather than as a fade. A `mask-image` is not a paint and does not count.
2. **Corners are 2px** (`--r`). Circles (`50%`) are exempt.
3. **Texture never sits behind body copy.** A `.tex` layer paints at
   `z-index:-1` beneath a solid panel, so contrast is a property of the layout
   rather than of an opacity guess.
4. **`--faint` and `--muted` are terminal tokens.** They measure roughly 2.3
   and 4.3 against the canvas and fail WCAG AA for small text. They belong to
   the mock terminal chrome; real copy uses `--ink-3` or lighter. Every page
   currently measures zero contrast failures — keep it that way.

`.reveal` is gated on a `.js` class set by a one-line script in each page's
`<head>`. Without it nothing is hidden, so a script that fails to load costs
the animation rather than the content.

`assets/` is excluded from the root ESLint config: this directory has no
tsconfig, so the TypeScript project service reports its browser JS as a parse
error rather than as findings.

**`read/index.html` is not on this system yet** — it still carries its own
`:root` block of hardcoded hexes rather than consuming `assets/oxagen.css`.
The colours match, but nothing keeps them matching (#1437).

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

## The blog

Two inputs, one rule: **a post links to one or more pillars, and the pillars
are the YAML.**

- `content/pillars.yaml` — the pillar list. Each pillar has a `slug` (its URL
  under `/blog/pillars/`), `name`, `tagline`, `description`, display `order`,
  and an `image` with `src`, `alt`, and a full `credit` (author, author URL,
  source, source URL, licence). Every field is required; the build refuses a
  pillar without them, and a post naming a pillar not in this file fails the
  build with the offending file and slug.
- `content/posts/<slug>/index.mdx` — one folder per post, the folder name is
  the URL (`/blog/<slug>`). Anything else in the folder is copied alongside
  the page, so a post can carry its own images at `/blog/<slug>/<file>`.
  Frontmatter:

  ```yaml
  ---
  title: "…"
  description: "…"          # ≤ 200 chars, becomes the meta description
  date: 2026-09-09          # ISO; `updated:` is optional
  authors: [Oxagen Research]
  pillars: [ontologies, ai-agents]   # first entry is the primary pillar
  tags: [knowledge-graphs]           # kebab-case
  image: /blog/<slug>/hero.jpg       # optional; defaults to the primary pillar's
  draft: false                       # drafts build only with BLOG_DRAFTS=1
  ---
  ```

- The body is Markdown with GFM (tables, footnotes) and two components:
  `<Callout kind="note|warn" title="…">` and `<Figure src alt caption />`.
  Citations are GFM footnotes (`claim.[^3]` … `[^3]: Authors (Year). *Title*.
  Venue. https://…`), which the build renders as the **References** section;
  a post with no footnotes fails the build, because these are research posts.
- What the build emits: `/blog` (index with the pillar strip and every post),
  `/blog/pillars/<slug>` (one per pillar, including empty ones),
  `/blog/<slug>` (the post: hero, sticky table of contents from its `##`
  headings, prose, references, related posts by shared pillar), and
  `/blog/feed.xml` (RSS). Each page carries Open Graph, canonical, and
  schema.org JSON-LD (`Blog`, `CollectionPage`, `BlogPosting`).
- Posts are rendered to plain HTML at build time. React and `@mdx-js/mdx` are
  devDependencies of this package only; the browser receives no JavaScript
  beyond `assets/oxagen.js`.

## Local preview

```bash
pnpm --filter @oxagen/web-v2 preview
# builds dist/ and serves it at http://localhost:5500 — the API allows this origin in non-production
```

The forms still post to `localhost:4000`, so run the API too if you want to
submit one.
