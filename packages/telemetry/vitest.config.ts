import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Several files here drive the REAL ClickHouse through the real
    // `migrate()`: schema-conformance-idempotency.integration.test.ts
    // (beforeAll), skill-execution-join.integration.test.ts, and
    // migrate-ledger.integration.test.ts. `migrate()` USED to keep no
    // applied-migrations ledger — it replayed schema.sql and every file in
    // migrations/ on every call — and 0021 opens with
    // `DROP TABLE IF EXISTS schema_conformance_events` (that migration's own
    // header named the replay as a known defect). Running those files in
    // parallel against one shared server let the second file's migrate()
    // drop the table out from under the first file's inserts mid-assertion,
    // so a count that should be 1 read 0. That raced main red on 16df074d
    // (second test failed) and again on 34ea88b3 (first test failed) — the
    // failing test moving between runs was the race's signature.
    //
    // #2632 gave migrate() a `_migrations` ledger: a migration already
    // recorded there is never re-executed by a later call, so 0021's DROP
    // no longer replays once ANY call has completed it — including the
    // one-time bootstrap that marks an existing deployment's backlog as
    // applied without re-running it. That closes the steady-state race this
    // setting was containing.
    //
    // One window is still open: a genuinely fresh database (empty ledger,
    // no pre-existing tables — exactly what CI provisions per run) has no
    // record to check yet, so two truly concurrent FIRST-EVER migrate()
    // calls could both decide 0021 is unapplied and both run it. ClickHouse
    // has no cross-statement locking migrate() could use to close that
    // window itself. Left in place until that gap is closed or otherwise
    // accepted — tracked on #2637 (the original race report), which still
    // owns the misleading-suite-title fix and a witness test proving
    // whether a fresh-database race survives with the ledger in place.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      // OXA-1898: lines/statements raised to the 85% gate (measured 98.1; the
      // migrate.ts live-CH path is not imported by the unit suite so it stays
      // out of the denominator). branches/functions left at prior floors.
      thresholds: {
        lines: 85,
        branches: 95,
        functions: 86,
        statements: 85,
      },
    },
  },
});
