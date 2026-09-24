# @oxagen/docs

The Fumadocs site for docs.oxagen.sh. It renders the MDX pages under
`content/docs/` and serves them as HTML, raw Markdown, and `llms.txt`.

## Boundary

- **Owns:** the published documentation pages (`content/docs/`), the site
  layout and landing page (`src/app/`), search (`src/app/api/search/`), the
  `llms.txt` and `llms-full.txt` exports, and the page frontmatter schema
  (`source.config.ts`).
- **Does not own:** the internal docs, ADRs, and capability specs
  (`docs/` at the repo root, navigated from `docs/README.md`); the release
  pages' content, which `pnpm release:*` writes to
  `content/docs/releases/v<version>.mdx` (`tools/scripts/release.ts`); the
  architecture atlas in `public/architecture/`, which `pnpm docs:architecture`
  generates (`tools/scripts/gen-architecture-docs.ts`); shared components and
  tokens ([`@oxagen/ui`](../../packages/ui/README.md)); the marketing site
  ([`apps/web`](../web/README.md)).
- **Depends on:** `@oxagen/ui`, for components (through
  `src/components/ui/`) and the theme tokens.
- **Used by:** no workspace package imports it. It is a deployed Next.js
  site.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Page frontmatter schema (`title`, `description`, `icon`, `full`, `date`) | boundary | `apps/docs/source.config.ts` | `fumadocs-mdx`, on `postinstall` and `gen:source` |
| Page source loader (`source`, `collectOrderedPageUrls`) | export | `apps/docs/src/lib/source.ts` | `src/app/docs/`, `src/app/llms.txt/`, `src/app/llms-full.txt/`, `src/app/llms.mdx/`, `src/app/api/search/`, `src/app/sitemap.ts` |
| `@oxagen/ui` re-export layer | adapter | `apps/docs/src/components/ui/` | Components in `src/`. `eslint.next.mjs` refuses direct `@oxagen/ui/components/*` imports elsewhere |
| Architecture atlas | boundary | `apps/docs/public/architecture/` | `pnpm docs:architecture`, run by `predev` and `prebuild` |
| Prose gate | boundary | `tools/scripts/check-prose.mjs` | `pnpm check:prose`, the pre-push hook, and CI. It scans `content/` and `src/app/(home)/` |

This app exposes no capability and calls no kernel.

## Entry points

- `content/docs/`: the pages. Each folder's `meta.json` sets sidebar order.
- `src/app/`: the App Router site, including `docs/[[...slug]]`, the landing
  page in `(home)/`, `api/search/`, and the `llms` routes.
- `source.config.ts`: the Fumadocs collection definition.
- `pnpm --filter @oxagen/docs dev` serves the site on port 3300.

## Rules

- A page describes what ships. A feature without a shipped implementation
  gets no page (`apps/docs/CLAUDE.md`).
- Copy follows `clear-prose` and the `oxagen-branding` vocabulary, and
  `pnpm check:prose` fails on em dashes, exclamation points, and the avoid
  list.
- Update the matching page when a capability contract changes.

## Tests

The app defines no `test:unit` script. Its checks are `pnpm check:prose`,
`lint`, and `typecheck`, and CI runs them.
