// migrate-concurrency.integration.test.ts
//
// The witness for the concurrency half of #2632/#2637.
//
// migrate-ledger.integration.test.ts already proves the ledger (#2632) makes
// a SEQUENTIAL second `migrate()` call skip a file the first one recorded.
// That is not the same claim as "two migrate() calls running concurrently
// against one ClickHouse cannot make a table disappear for the other" — the
// concurrency case this file covers.
//
// `appliedMigrations()` inside migrate.ts's migrateOnce() is read ONCE per
// call into a local Set and never refreshed for the rest of that call's loop
// over migrations/*.sql. Two calls whose execution windows OVERLAP both take
// that snapshot before either has recorded a not-yet-applied file, so both
// decide it is unapplied — and for a DROP+RECREATE file like
// 0021_schema_conformance_events_idempotency.sql, both replay the DROP.
//
// An earlier version of this test tried to witness that by inserting a row
// BEFORE clearing the file's ledger entry and asserting the row survived the
// race. That assertion cannot pass either way: once a file's ledger row is
// cleared, genuinely applying it ONE time is correct behaviour — it is a
// DROP+RECREATE migration, so the very first (and only necessary) apply
// legitimately empties the table. A pre-existing row is not evidence of a
// race; it is evidence that the migration was, correctly, applied at least
// once. The actual signature of the race is not "does data survive" but
// "does the DROP run once or twice" — a second, redundant execution is what
// can drop a table a caller elsewhere just finished repopulating. So this
// test spies on the real ClickHouse client's command() (pass-through, real
// execution preserved) and counts how many times 0021's DROP statement is
// actually sent, plus how many rows land in the ledger — `_migrations` is a
// plain MergeTree with no dedup engine, so two racing INSERTs are visibly
// two rows, not one merged one.
//
// Without migrate.ts's same-process serializing queue (`migrationQueue`),
// both calls take their ledger snapshot before either records RACED_FILE, so
// both execute its statements and both record it: two DROPs, two ledger
// rows. With the queue, the second call's migrateOnce() does not start until
// the first has finished and recorded the file, so its own (later) snapshot
// sees it as applied and skips it: one DROP, one ledger row. Verified by
// temporarily calling migrateOnce() directly from migrate() (i.e. removing
// the queue) — see the PR description for the exact command and output.
//
// What this does NOT cover: two SEPARATE processes (module state cannot span
// processes). See the "Same-process concurrency guard" comment above
// `migrationQueue` in migrate.ts and issue #2687 for that residual gap and
// why it is accepted rather than fixed here.
//
// Like this package's other DDL-lifecycle integration tests, this runs
// against the real local ClickHouse (docker :8123) and skips cleanly when it
// is unreachable — a mocked client accepts any SQL without complaint and
// cannot distinguish "the DROP ran once" from "the DROP ran twice", which is
// the entire content of this defect.

import { afterAll, describe, expect, it, vi } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

async function clickhouseReachable(): Promise<boolean> {
  try {
    const url = new URL("/ping", process.env.CLICKHOUSE_URL);
    const res = await fetch(url, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

const chUp = await clickhouseReachable();

afterAll(async () => {
  if (!chUp) return;
  const { closeClickhouse } = await import("./clickhouse");
  await closeClickhouse();
});

// The DROP+RECREATE migration this whole cluster of defects (#2632, #2637)
// is about — see its own header for why it rebuilds instead of ALTERing.
const RACED_FILE = "0021_schema_conformance_events_idempotency.sql";

async function ledgerCountFor(filename: string): Promise<number> {
  const { clickhouse } = await import("./clickhouse");
  const ch = clickhouse();
  const result = await ch.query({
    query: `SELECT count() AS c FROM _migrations WHERE filename = {f:String}`,
    query_params: { f: filename },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ c: string }>();
  return Number(rows[0]?.c ?? -1);
}

describe.skipIf(!chUp)(
  "migrate() concurrent invocation (#2637 concurrency witness) (integration)",
  () => {
    it("two migrate() calls fired together apply a not-yet-ledgered DROP+RECREATE migration exactly once, not twice", async () => {
      const { migrate } = await import("./migrate");
      const { clickhouse } = await import("./clickhouse");
      const ch = clickhouse();

      // Baseline: guarantee the ledger and every table (including
      // schema_conformance_events) exist before manipulating ledger state.
      await migrate();

      // Force RACED_FILE back to "unapplied" so the NEXT migrate() calls
      // each take a ledger snapshot that omits it — the exact state two
      // callers deploying this migration for the first time (or racing
      // any future DROP+RECREATE migration) would each see.
      // mutations_sync forces the delete to be visible to the very next
      // SELECT rather than landing as an eventually-consistent background
      // mutation.
      await ch.command({
        query: `ALTER TABLE _migrations DELETE WHERE filename = {f:String}`,
        query_params: { f: RACED_FILE },
        clickhouse_settings: { mutations_sync: "1" },
      });
      expect(await ledgerCountFor(RACED_FILE)).toBe(0);

      // Spy on the real client's command() — pass-through, so migrate()
      // still executes every statement for real. This only records what
      // was sent, so it can count how many times 0021's DROP is issued.
      const commandSpy = vi.spyOn(ch, "command");

      try {
        // Fire both calls in the same tick.
        await Promise.all([migrate(), migrate()]);

        const dropCalls = commandSpy.mock.calls.filter(([opts]) =>
          (opts as { query: string }).query.includes(
            "DROP TABLE IF EXISTS schema_conformance_events",
          ),
        );
        // Without the queue, both calls independently decide RACED_FILE is
        // unapplied and both execute its DROP — dropCalls.length === 2.
        expect(dropCalls).toHaveLength(1);

        // _migrations has no dedup engine (plain MergeTree): a second,
        // racing INSERT for the same filename is a second row, not a
        // merged one. Exactly one row is the same "applied once"
        // guarantee stated structurally rather than by counting SQL sent.
        expect(await ledgerCountFor(RACED_FILE)).toBe(1);
      } finally {
        commandSpy.mockRestore();
      }
    }, 60_000);
  },
);
