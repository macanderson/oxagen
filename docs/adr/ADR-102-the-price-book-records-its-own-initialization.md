# ADR-102: The price book records its own initialization

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform, billing
- **Related:** ADR-060 (`cost.*`: the price book as data and the spend
  rollups); Mission Control spec §12.2, §12.6, §12.7; the migrations
  `20260918203000_price_entries_catalog_provenance.sql` (the `catalog` stamp
  per-catalog retirement reads) and
  `20260919190000_cost_price_book_initializations.sql` (this record);
  `docs/capabilities/cost.price_entry.set.md`
- **Numbering:** 102. ADR-101 is taken by the four first-class harnesses
- **Delivered by:** `cost.price_book_initializations`, `syncPriceBook` in
  `packages/billing/src/price-book.ts`, and the `cost.price-book-sync` job

## Context

The list price book fills itself. The hourly `cost.price-book-sync` job merges
the operator's overrides, the published catalogs, and the in-code rate card,
and writes the result through `syncPriceBook`. On a fresh install the first
tick is the first writer, and runs Oxagen accepted before it have frames older
than any price. So while the book is cold, a key it has never priced is written
effective from `COLD_BOOK_EFFECTIVE_FROM` (2020-01-01), an instant before every
frame, and those earlier frames price at the first known rate instead of at
nothing. The window is seven days from initialization, which is long enough for
a catalog that was down at the first sync to come back.

That floor is a retroactive write, and it is the only one the sync makes. It is
correct for exactly one case: a source that was down at initialization,
recovering. For any other new key it hands a rate to frames recorded since the
first sync, and the next rollup changes what runs already sealed cost.

So the sync has to know which sources answered at initialization. It read that
off `cost.price_entries`: every row the first sync inserted carries that
transaction's `created_at`, and each list row carries the `catalog` that
published it, so the catalogs stamped on rows created at the book's earliest
instant looked like the set that answered. That needed no new column.

It is wrong, and the way it is wrong is silent. `mergePublishedPrices` gives
each model to one source outright: an operator override beats a catalog, and one
catalog beats another. A catalog that answered completely at the first sync and
lost every one of its models to a higher-precedence source contributes no row to
the book. The reconstruction therefore omits it, and cannot tell it from a
catalog that was down. When that catalog later publishes its first unique model
inside the seven-day window, the sync reads a recovery, backdates the rate to
2020, and a later rollup reprices runs that had settled.

Source completion cannot be inferred from rows after precedence has filtered
them. The set is available where it would be written: `syncPriceBook` already
takes `completedCatalogs` on every sync, the first included, and the retirement
pass already depends on it. What was missing was somewhere to keep it.

## Decision

The price book records its own initialization, in one durable row.

`cost.price_book_initializations` holds `book` (the primary key, `'list'`),
`initialized_at`, and `completed_catalogs`. The sync that creates the book
writes it in the same transaction as the book's first rows, with the
`completedCatalogs` the caller vouched for on that run, and
`ON CONFLICT DO NOTHING` so a second writer cannot overwrite the first's view.
Every later sync reads it: `initialized_at` bounds the cold window, and
`completed_catalogs` decides whether a new key is a source recovering or a
model that did not exist before today.

Three things follow from where it lives.

**Postgres, in `cost`, beside `price_entries`.** It is durable transactional
state that a write path reads and a correctness rule depends on, which is
Postgres by the storage boundary. It is written in the same transaction as the
rows it describes, so nothing can leave a book without a record or a record
without a book. It is not telemetry: ClickHouse is append-only runtime events,
and a fact the cold-start floor consults on every sync is not an event, it is
state. It is not a marker row in `price_entries` either. A marker there would be
a resolvable price that never applied, readable by `resolvePriceEntry` and
countable by the retirement pass, and the `catalog` column already holds exactly
one publisher id that per-catalog retirement depends on, so it cannot carry a
set.

**No RLS.** The row has no `org_id` and no `workspace_id`, because the list book
is per install and every organization reads it. Tables with no scoping column
are intentionally absent from `packages/database/src/tenant-policy.manifest.ts`
(`billing.plans`, `mcp.catalog_servers`, the Better Auth tables), and this is
one of them. `withSystemDb` is the executor, as it already is for the rest of
`syncPriceBook`.

**A missing record means the sources are unknown, and unknown never floors.** An
install that already has a book has no record, and one cannot be invented for
it: the fact is exactly the one the rows cannot answer. So a key is floored as a
recovery only on positive evidence that its source was absent at
initialization, which is the record existing, the seed naming its catalog, and
that catalog not being in the record. A book with no record floors nothing, and
neither does a seed that names no catalog.

That asymmetry is the point. Declining to floor costs a frame that stays
unpriced until a real sync prices its model forward, which shows up in the
unpriced-models report and can be repaired. Flooring on an unknown changes the
cost of runs that already sealed, under the same entry id, on the next rollup
retry, and nothing shows it. Settled cost does not move.

## Consequences

- One table, four columns of content, one row per install. No capability, no
  route, no tool: the sync is the only reader and the only writer.
- A legacy install, and any install whose book predates the migration, keeps the
  book it has and floors nothing further. Its cold window is bounded by the
  earliest row's `created_at`, as before, and the window has long since closed
  on every install that has been running more than seven days.
- A catalog that was genuinely down at the first sync of a legacy install will
  not have its late models backdated. Those frames read `estimated` rather than
  a rate invented for them.
- The `catalog` stamp on `price_entries` keeps its one job, per-catalog
  retirement. Nothing else now infers initialization from it.

## Alternatives rejected

**Infer completion more widely from the rows.** Treat a catalog as having
answered when any model it publishes today has a row created at the
initialization instant, whoever won it. It needs no storage, and it drops a real
recovery: a catalog that was down at the first sync, whose other models the
in-code card priced at that same instant, reads as having answered, so a model
it publishes later is not floored. It is another inference from rows, which is
the thing that failed.

**A marker row in `price_entries`.** A resolvable price that never applied, and
the `catalog` column holds one id, not a set. Rejected above.

**ClickHouse.** Append-only telemetry, queried for analysis. The cold-start
floor reads this on every sync and must get the same answer every time.
