# The book's manuscript

"Engineering Deterministic AI Coding Agents", second edition. This folder is the
only place the text lives (ADR-155). The two editions one level up and the
migration that ships them are generated from it.

## Change the book

1. Edit a fragment here. `book.json` lists the sections in order.
2. Run `pnpm book:build`. It writes `../field-manual.html`,
   `../page-flip-reader.html`, and the migration named by `MIGRATION_NAME` in
   `tools/scripts/build-book-editions.mjs`. It exits 1 and names the file when
   a fragment breaks a prose or structure rule.
3. From `packages/database`, run
   `atlas migrate hash --dir "file://atlas/migrations"`.
4. Commit the fragment, both editions, the migration, and `atlas.sum` together.

If the current migration has already been applied to production, give
`MIGRATION_NAME` a later timestamp before you rebuild, and keep the old file.

## What a fragment holds

A fragment is the inner HTML of one section. The build adds the `<section>`
wrapper, the kicker, the sidebar entry, and the previous and next links.

A part (`p01.html` to `p21.html`) keeps this order: `ch-title`, `ch-thesis`,
`lede`, the body, then `todo` ("Do this week"), `measure` ("Measure it"), and
`takeaway`. The build fails a part that lacks any of the five fixed blocks.

| Block | Class | Shape |
|---|---|---|
| Published evidence, cited | `evidence` | Left rule |
| Where the argument stops | `counter` | Dashed |
| Steps for this week | `todo` | Dashed |
| Metrics | `measure` | Single border |
| What the product does, and its boundary | `fits` | Double border |
| The part in one paragraph | `takeaway` | Filled |

- Put every table inside `<div class="tablewrap">`.
- Cite with `<sup class="cite"><a href="#r7">7</a></sup>`. The id has to exist in
  `refs.html`. Do not renumber references.
- Wrap content only the field manual can run in `<!-- fm-only -->` and
  `<!-- /fm-only -->`. The reader drops it.
- `{{AUTHOR_PHOTO}}` becomes a data URI in the field manual and a site URL in
  the reader.

## Prose

Load the `clear-prose` and `oxagen-branding` skills before you write. The build
checks what a script can: no em or en dashes anywhere, no exclamation points or
semicolons in prose, and none of the banned words. It cannot check claims.
Parts 1 to 13 name no product. Parts 14 to 20 keep product claims inside the
"Where Oxagen fits" box, scoped to actions routed through Oxagen. Never add a
number, a study, or a source you have not read.

## The shells

`shells/*.shell.html` hold each edition's page, styles, and script. The
page-flip mechanics and the PDF export live in the reader shell. Edit a shell
only to change how an edition looks or behaves, then rebuild.
