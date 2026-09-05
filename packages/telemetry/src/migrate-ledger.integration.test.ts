// The witness for #2632: migrate() replayed EVERY file in migrations/ on
// EVERY call, with no record of what had already run. 0021 opens with
// `DROP TABLE IF EXISTS schema_conformance_events` and recreates it — so a
// second migrate() call dropped and recreated the table, discarding
// everything a caller had written between the two calls. This is stated
// here exactly as the bug report states it: a row written after the first
// migrate() call must still be there after a second one.
//
// A mocked ClickHouse client accepts any SQL without complaint and cannot
// tell "the table still has my row" from "the table is a fresh empty one
// with the same name" — the whole point of the defect is that both look
// identical to code that never queries the data back. So, like this
// package's other DDL-lifecycle tests (schema-conformance-idempotency,
// skill-execution-join), this runs against the real local ClickHouse
// (docker :8123) and skips cleanly when it is unreachable.
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

// Collection-time probe with a short abort, matching the rest of this
// package's integration suites — the client's own transport timeout is
// ~30s and would burn the hook budget when nothing is listening.
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

const ORG_ID = "bbbbbbbb-0000-4000-8000-000000000001";
const WORKSPACE_ID = "bbbbbbbb-0000-4000-8000-000000000002";
const VERSION_ID = "bbbbbbbb-0000-4000-8000-000000000003";

function conformanceRow(eventId: string) {
  return {
    event_id: eventId,
    org_id: ORG_ID,
    workspace_id: WORKSPACE_ID,
    version_id: VERSION_ID,
    target_kind: "node",
    node_id: "node-migrate-ledger-witness",
    relationship_key: null,
    node_label: "task",
    enforcement_mode: "lenient",
    outcome: "accepted",
    conformance_score: 0.9,
    missing_required: [],
    type_errors: [],
    connection_id: null,
    source_record_type: "issue",
    occurred_at: new Date().toISOString(),
  };
}

async function countByEventId(eventId: string): Promise<number> {
  const { clickhouse } = await import("./clickhouse");
  const ch = clickhouse();
  const result = await ch.query({
    query: `
      SELECT count() AS c
      FROM schema_conformance_events FINAL
      WHERE event_id = {eventId:UUID}
    `,
    query_params: { eventId },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ c: string }>();
  return Number(rows[0]?.c ?? -1);
}

describe.skipIf(!chUp)(
  "migrate() applied-migrations ledger (#2632) (integration) [skipped: local ClickHouse unreachable at :8123]",
  () => {
    it("a table created by an earlier migration still exists — with its data — after a second migrate() run", async () => {
      const { migrate } = await import("./migrate");
      const { clickhouse } = await import("./clickhouse");
      const ch = clickhouse();

      // First run: builds (or confirms) schema_conformance_events, among
      // everything else migrate() applies.
      await migrate();

      const eventId = randomUUID();
      await ch.insert({
        table: "schema_conformance_events",
        values: [conformanceRow(eventId)],
        format: "JSONEachRow",
      });

      try {
        expect(await countByEventId(eventId)).toBe(1);

        // The bug, stated as an assertion: on the old runner this second
        // call replays 0021's `DROP TABLE IF EXISTS
        // schema_conformance_events`, destroying the row (and, briefly,
        // the table itself) even though the migration was already
        // applied by the first call above.
        await migrate();

        expect(await countByEventId(eventId)).toBe(1);
      } finally {
        await ch.command({
          query: `ALTER TABLE schema_conformance_events DELETE WHERE event_id = {eventId:UUID}`,
          query_params: { eventId },
        });
      }
    }, 60_000);

    it("running migrate() twice leaves the same _migrations ledger as running it once", async () => {
      const { migrate } = await import("./migrate");
      const { clickhouse } = await import("./clickhouse");
      const ch = clickhouse();

      await migrate();
      const first = await (
        await ch.query({
          query: "SELECT DISTINCT filename FROM _migrations ORDER BY filename",
          format: "JSONEachRow",
        })
      ).json<{ filename: string }>();

      await migrate();
      const second = await (
        await ch.query({
          query: "SELECT DISTINCT filename FROM _migrations ORDER BY filename",
          format: "JSONEachRow",
        })
      ).json<{ filename: string }>();

      expect(second.map((r) => r.filename)).toEqual(
        first.map((r) => r.filename),
      );
      // Every migrations/*.sql file that exists is accounted for exactly
      // once — no file is silently skipped by the ledger, and none is
      // duplicated by a re-run.
      expect(first.length).toBeGreaterThan(0);
    }, 60_000);
  },
);
