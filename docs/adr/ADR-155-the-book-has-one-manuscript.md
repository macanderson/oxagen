# ADR-155: The book has one manuscript, and its editions and migration are generated

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** marketing, platform
- **Related:** ADR-154 (the restored ebook lead gate and `cms.book_editions`);
  ADR-043 (the cut that dropped `cms` and took both editions offline for twelve
  days); the migrations `20260919131000_seed_cms_book_editions.sql`,
  `20260919150000_update_page_flip_reader_edition.sql`, and
  `20260920130000_book_second_edition.sql`
- **Numbering:** 109. ADR-104 to ADR-108 were taken on `main` while this branch
  was open. Renumbered to 155 on 2026-09-23, because ADR-109 had been
  merged twice.
- **Delivered by:** `packages/database/seed-assets/books/manuscript/`,
  `tools/scripts/build-book-editions.mjs`, and
  `tools/scripts/build-book-editions.test.ts`

## Context

"Engineering Deterministic AI Coding Agents" ships in two editions: a scrolling
field manual that prints, and a page-flip reader with a PDF export. Both are
single HTML files under `packages/database/seed-assets/books/`. The redeem
route serves them from `cms.book_editions`.

Three copies of the text existed, and nothing held them together.

1. **Each edition held its own copy of the book.** The two files shared
   chapter markup and differed by hand in about forty places. A correction to
   one did not reach the other.
2. **Production held a third copy.** Production takes book HTML only from Atlas
   migrations, because `infra/tools/run-db-migrations.sh` runs
   `atlas migrate apply` and never the Node seed. `20260919131000` embedded both
   files as they stood that day. `20260919150000` then had to patch the reader
   with three `replace()` calls, and a test had to hold those pairs to the seed
   file.
3. **The seed and the migration applied different transforms.** The Node seed
   strips a legacy client-side redirect from the field manual. A migration
   cannot run that code, so the migration author had to strip it by hand and
   say so in a comment.

The second edition rewrites every part, adds seven, and adds a field kit. A
change of that size made by hand, three times, would not have stayed consistent.

## Decision

1. **The manuscript is the only place the text lives.** `manuscript/book.json`
   lists the sections in order. Each section is one HTML fragment that holds its
   inner content only. The build writes the `<section>` wrapper, the kicker, the
   sidebar, the previous and next links, and the reader's manifest.
2. **Each edition is a shell with placeholders.** `manuscript/shells/` holds the
   page, styles, and script of each edition, cut from the files that shipped,
   with `{{PLACEHOLDERS}}` where the manuscript goes. The page-flip mechanics
   and the PDF export are unchanged. Content that only one edition can run, such
   as the calculator, sits between `<!-- fm-only -->` markers.
3. **The migration is generated from the same build.** The script writes the
   two edition files and a migration that updates both rows. The migration is an
   `UPDATE`, because `20260919131000` created the rows, and it does not touch
   `published`.
4. **The field manual carries no client-side gate.** Access is enforced by the
   redeem route. With the legacy redirect gone from the shell, the file on disk
   is byte for byte what the seed and the migration store, and neither needs a
   transform to agree with the other. The seed keeps its two transforms, which
   are now no-ops, so an older file still seeds correctly.
5. **A test holds the outputs to the manuscript.** It rebuilds in memory and
   fails when either edition or the migration differs from what the manuscript
   produces. It also fails on the prose rules a script can check (dashes,
   exclamation points, semicolons in prose, the banned words) and on structure:
   a part without its checklist or metrics, a table outside the scrolling
   container, a citation with no reference behind it.

## Consequences

- To change the book, edit a fragment, run
  `node tools/scripts/build-book-editions.mjs`, and rehash with
  `atlas migrate hash --dir "file://atlas/migrations"` from `packages/database`.
- An edit that must reach production after `20260920130000` has been applied
  needs a new migration. Change `MIGRATION_NAME` in the script to a later
  timestamp, rebuild, and keep the old file. Atlas refuses a changed checksum
  on an applied migration, so the old file cannot be regenerated in place.
- Each content migration embeds both editions, about 650 KB. That is the cost of
  production taking its data only from migrations, and ADR-154 already accepted
  it.
- The generated editions are committed. The seed reads them at run time and has
  no build step, and a reviewer can open the file a reader will get.
- Nothing migrates production on merge. After this merges, someone runs
  `infra/tools/run-db-migrations.sh` from an `origin/main` checkout, as for any
  other migration.

## Alternatives considered

- **Keep editing the two files by hand.** Rejected. It is how the three copies
  drifted, and the second edition is too large a change to make three times.
- **Store the manuscript in the database and render editions in the API.**
  Rejected. It puts a template engine in a route that today returns one column,
  and the editions would stop being files a person can open and print.
- **Generate the editions at seed time and do not commit them.** Rejected. The
  migration needs the built HTML at authoring time, and CI would need the build
  before every seed.
