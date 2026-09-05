# src/content/marketing — how these files were built

Four pairs of files, one per migrated page, extracted from `apps/web`'s
static HTML at the time of the copy (`apps/web` itself was not modified):

| Page | Source | `.html` is | `.css` is |
|---|---|---|---|
| `home` | `apps/web/index.html` | the `<body>` content | the page's own `<head><style>` block |
| `stella` | `apps/web/products/stella/index.html` | same | same |
| `oxagen` | `apps/web/products/oxagen/index.html` | same | same |
| `private-llms` | `apps/web/products/private-llms/index.html` | same | same |

`apps/web/assets/oxagen.css` and `apps/web/assets/oxagen.js` (the shared nav,
drawer, reveal-on-scroll, typewriter, and lead-form behaviour) are copied
into `public/assets/` unmodified and loaded once, in
`src/app/(marketing)/layout.tsx`.

## Link rewrites applied to every `.html` file here

- `/products/{stella,oxagen,private-llms}` → `/product/{stella,oxagen,private-llms}`
  (the brief asked for singular `/product/*`; `apps/web` itself still uses
  `/products/*` and was not changed).
- `https://docs.oxagen.sh` → `/docs` (the platform docs are now this same
  app's `/docs/*`, not a separate site).
- `https://stella.oxagen.sh` → `/docs/stella` (same reasoning, for Stella's
  docs).

External links were left alone: `github.com/...`, `app.oxagen.sh`,
`x.com/...`, `linkedin.com/...`, `huggingface.co/...`.

## Known gaps, carried over rather than fixed here

- `/read` (the field-manual ebook reader) is linked from the home page and
  is not built in `apps/web2` — visiting it 404s. Building that reader was
  out of scope for this migration.
- The lead-capture forms (`#manualForm`, `#demoForm`) render and validate
  client-side exactly as before, but nothing in `apps/web2` implements the
  `/v1/cms/...` endpoints they post to. Wiring a real backend was explicitly
  out of scope ("do not wire any deploy... yet").
