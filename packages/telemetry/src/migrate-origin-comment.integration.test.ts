// The origin design (#3192) rests on three claims about how ClickHouse treats
// a table COMMENT, and until this file every one of them was taken from the
// documentation and asserted against a mock:
//
//   1. `CREATE TABLE ... COMMENT '...'` stores the comment, and
//      `system.tables.comment` reads it back. This is how a ledger records
//      what it was born from, atomically with its own creation.
//   2. `CREATE TABLE IF NOT EXISTS ... COMMENT '...'` against an EXISTING
//      table leaves that table's comment alone. The whole design turns on
//      this: it is what stops a later run — one that can no longer observe
//      what the database used to be — from overwriting an origin with a guess.
//   3. `ALTER TABLE ... MODIFY COMMENT '...'` sets the comment on a table that
//      already exists. This is the backfill for a ledger created before the
//      stamp existed, and it is the statement the recovery instructions in
//      `ambiguousLedgerMessage()` tell a human to run by hand.
//
// None of the three is reachable from CI's ordinary migrate path: CI
// provisions an empty ClickHouse, so `_migrations` is always created fresh,
// `backfillOrigin` is always null, and `MODIFY COMMENT` is never sent. The
// `test` job going green said nothing about any of this. A mocked client
// accepts every one of these statements without complaint and would accept
// them just as readily if ClickHouse did not, which is precisely the shape of
// evidence this PR spent its rounds learning not to trust.
//
// So this runs the three statements against the real server — the local docker
// ClickHouse, or CI's service container — and skips cleanly when none is
// listening. It uses a scratch table rather than `_migrations`, because the
// ledger's real comment is load-bearing for migrate-ledger.integration.test.ts
// and migrate-concurrency.integration.test.ts sharing this same server.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

/**
 * Collection-time probe with a short abort, matching this package's other
 * integration suites — the client's own transport timeout is ~30s and would
 * burn the hook budget when nothing is listening.
 */
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

/** Unique per run, so a crashed earlier run cannot collide with this one. */
const PROBE = `_migrations_origin_probe_${randomUUID().replace(/-/g, "")}`;

const BORN_WITH = "oxagen ledger origin: fresh database";
const NEVER_APPLIED = "oxagen ledger origin: pre-ledger deployment";

afterAll(async () => {
  if (!chUp) return;
  const { clickhouse, closeClickhouse } = await import("./clickhouse");
  try {
    await clickhouse().command({ query: `DROP TABLE IF EXISTS ${PROBE}` });
  } finally {
    await closeClickhouse();
  }
});

async function commentOf(table: string): Promise<string | null> {
  const { clickhouse } = await import("./clickhouse");
  const result = await clickhouse().query({
    query: `SELECT comment FROM system.tables WHERE database = currentDatabase() AND name = '${table}'`,
    format: "JSONEachRow",
  });
  const rows = await result.json<{ comment: string }>();
  return rows[0]?.comment ?? null;
}

async function createProbe(comment: string): Promise<void> {
  const { clickhouse } = await import("./clickhouse");
  await clickhouse().command({
    query: `
      CREATE TABLE IF NOT EXISTS ${PROBE}
      (
          filename    String,
          applied_at  DateTime64(3) DEFAULT now64(3)
      )
      ENGINE = MergeTree
      ORDER BY filename
      COMMENT '${comment}'
    `,
  });
}

describe.skipIf(!chUp)("the origin comment, against a real ClickHouse", () => {
  it("is stored by the CREATE that makes the table and read back from system.tables", async () => {
    // Claim 1. This is how a ledger records its origin atomically with its own
    // creation — the property that leaves no window between "table exists" and
    // "origin known" for a crash to fall into.
    await createProbe(BORN_WITH);
    expect(await commentOf(PROBE)).toBe(BORN_WITH);
  });

  it("is NOT rewritten by a later CREATE TABLE IF NOT EXISTS", async () => {
    // Claim 2, and the one the design most depends on. A second run against an
    // existing ledger passes whatever origin its own snapshot suggests; if that
    // overwrote the stored one, a run that can no longer see what the database
    // used to be would be free to replace a true origin with a guess.
    await createProbe(NEVER_APPLIED);
    expect(await commentOf(PROBE)).toBe(BORN_WITH);
  });

  it("is settable afterwards with ALTER TABLE ... MODIFY COMMENT", async () => {
    // Claim 3: the backfill for a ledger created before the stamp existed, and
    // the statement ambiguousLedgerMessage() hands to a human to run by hand.
    // If this throws on the server this repo actually runs, that recovery
    // instruction is wrong and the automatic backfill silently degrades to a
    // warning — which is exactly what the unit tests could not tell us.
    const { clickhouse } = await import("./clickhouse");
    await clickhouse().command({
      query: `ALTER TABLE ${PROBE} MODIFY COMMENT '${NEVER_APPLIED}'`,
    });
    expect(await commentOf(PROBE)).toBe(NEVER_APPLIED);
  });

  it("reads back as an empty string for a table created without one", async () => {
    // The legacy shape: a ledger from before the stamp. `decideLedgerAction`
    // treats "" as "no origin recorded", so it matters that ClickHouse reports
    // an absent comment that way rather than as null or as a missing column.
    const { clickhouse } = await import("./clickhouse");
    const bare = `${PROBE}_bare`;
    try {
      await clickhouse().command({
        query: `CREATE TABLE IF NOT EXISTS ${bare} (filename String) ENGINE = MergeTree ORDER BY filename`,
      });
      expect(await commentOf(bare)).toBe("");
    } finally {
      await clickhouse().command({ query: `DROP TABLE IF EXISTS ${bare}` });
    }
  });
});
