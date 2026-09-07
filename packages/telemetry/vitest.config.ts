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
    // One window was still open: a genuinely fresh database (empty ledger,
    // no pre-existing tables — exactly what CI provisions per run) has no
    // record to check yet, so two truly concurrent migrate() calls could
    // both decide a not-yet-ledgered file is unapplied and both run it.
    // #2637 confirmed this with migrate-concurrency.integration.test.ts
    // (clear a file's ledger row, fire two migrate() calls with
    // Promise.all) and gave migrate() a same-process serializing queue
    // (`migrationQueue` in migrate.ts) that closes it for two calls sharing
    // one Node module. It does NOT close the gap between two SEPARATE
    // processes — module state cannot span processes, and ClickHouse has no
    // cross-statement lock migrate() could take out to close it from the SQL
    // side. This setting stays in place as the containment for exactly that
    // remaining shape (two different vitest worker files, each its own
    // isolated module registry, racing one shared CI ClickHouse); #2687
    // tracks a real cross-process guard.
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
