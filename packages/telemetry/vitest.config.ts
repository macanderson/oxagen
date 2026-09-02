import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    clearMocks: true,
    environment: "node",
    globals: false,
    include: ["src/**/*.test.ts"],
    // Two files here drive the REAL ClickHouse through the real `migrate()`:
    // schema-conformance-idempotency.integration.test.ts (beforeAll) and
    // skill-execution-join.integration.test.ts. `migrate()` keeps no
    // applied-migrations ledger — it replays schema.sql and every file in
    // migrations/ on every call — and 0021 opens with
    // `DROP TABLE IF EXISTS schema_conformance_events` (that migration's own
    // header names the replay as a known defect). Run those two files in
    // parallel against one shared server and the second file's migrate()
    // drops the table out from under the first file's inserts mid-assertion,
    // so a count that should be 1 reads 0. That raced main red on 16df074d
    // (second test failed) and again on 34ea88b3 (first test failed) — the
    // failing test moving between runs is the race's signature.
    // Serialising this package's files removes the overlap: each file's
    // migrate() now completes before its own tests run. The real fix is a
    // ledger in migrate() (or a rename-based rebuild) so DROP stops
    // replaying — tracked separately; that also ends the 90-day telemetry
    // wipe every deploy currently performs.
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
