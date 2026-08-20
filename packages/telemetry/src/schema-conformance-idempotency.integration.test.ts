// schema-conformance-idempotency.integration.test.ts
//
// OXA-1932: integration coverage for the ReplacingMergeTree dedup half of the
// fix (the deterministic event_id half is unit-tested against real
// deterministicEventId() logic in
// packages/ingestion/src/mutations/__tests__/upsert-entity.test.ts).
//
// This repo has a documented gotcha (see .oxagen memories:
// clickhouse-mocked-tests-miss-sql) — mocked ClickHouse unit tests can pass
// invalid SQL/DDL undetected. ReplacingMergeTree dedup-on-merge specifically
// cannot be verified against a mock (there is no merge to simulate), so these
// tests run against the real local ClickHouse (docker :8123, matching
// packages/telemetry/src/clickhouse.test.ts / lease.integration.test.ts's
// "skip cleanly when unreachable" convention) rather than faking the engine
// behaviour.
//
// What this proves that a mock cannot:
//   1. The 0021 migration is syntactically valid ClickHouse DDL (migrate()
//      actually runs it against the live server).
//   2. Two inserts sharing the SAME deterministic event_id (simulating an
//      Inngest step retry re-executing the whole emitConformanceEvent call)
//      collapse to ONE row after ReplacingMergeTree merges — the literal
//      "same conformance event inserted twice, only one logical event
//      counted" acceptance criterion from the ticket.
//   3. Two inserts with DIFFERENT event_ids (simulating two genuinely
//      separate ingestion runs of the same entity) do NOT collapse — the fix
//      must not turn into an over-aggressive dedup that silently drops real
//      historical signal.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

process.env.CLICKHOUSE_URL ??= "http://localhost:8123";
process.env.CLICKHOUSE_USERNAME ??= "default";
process.env.CLICKHOUSE_PASSWORD ??= "";
process.env.CLICKHOUSE_DATABASE ??= "oxagen";

// Short reachability probe, run at collection time so the suite can skip
// BEFORE any hook touches the network. The ClickHouse client's own transport
// timeout is ~30s, so probing via the client (or inside beforeAll) burns the
// full 60s hook timeout when no server is listening — a raw HTTP GET with a
// 500ms abort answers "unreachable" fast instead.
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

beforeAll(async () => {
  if (!chUp) return;
  const { migrate } = await import("./migrate");
  // Applies schema.sql + every file in migrations/ (idempotent), including
  // 0021_schema_conformance_events_idempotency.sql — the actual DDL under
  // test here, run against a real server rather than asserted as a string.
  await migrate();
  // 60s: migrate() replays the full migration chain; under a whole-monorepo
  // turbo run it can exceed vitest's 10s default hook timeout.
}, 60_000);

afterAll(async () => {
  if (!chUp) return;
  const { closeClickhouse } = await import("./clickhouse");
  await closeClickhouse();
});

const ORG_ID = "aaaaaaaa-0000-4000-8000-000000000001";
const WORKSPACE_ID = "aaaaaaaa-0000-4000-8000-000000000002";
const VERSION_ID = "aaaaaaaa-0000-4000-8000-000000000003";

function baseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    org_id: ORG_ID,
    workspace_id: WORKSPACE_ID,
    version_id: VERSION_ID,
    target_kind: "node",
    node_id: "node-oxa-1932",
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
    ...overrides,
  };
}

async function countByEventId(eventId: string): Promise<number> {
  const { clickhouse } = await import("./clickhouse");
  const ch = clickhouse();
  const result = await ch.query({
    query: `
      SELECT count() AS c
      FROM schema_conformance_events FINAL
      WHERE event_id = {eventId:UUID} AND org_id = {orgId:UUID}
    `,
    query_params: { eventId, orgId: ORG_ID },
    format: "JSONEachRow",
  });
  const rows = await result.json<{ c: string }>();
  return Number(rows[0]?.c ?? -1);
}

async function cleanup(eventIds: string[]): Promise<void> {
  if (eventIds.length === 0) return;
  const { clickhouse } = await import("./clickhouse");
  const ch = clickhouse();
  const list = eventIds.map((id) => `'${id}'`).join(", ");
  await ch.command({
    query: `ALTER TABLE schema_conformance_events DELETE WHERE event_id IN (${list})`,
  });
}

describe.skipIf(!chUp)(
  "schema_conformance_events — ReplacingMergeTree idempotency (OXA-1932, integration) [skipped: local ClickHouse unreachable at :8123]",
  () => {
    it("collapses two inserts sharing the same deterministic event_id into ONE row after merge", async () => {
      const { clickhouse } = await import("./clickhouse");
      const { deterministicEventId } = await import("./idempotency");
      const ch = clickhouse();

      // The exact identity emitConformanceEvent now derives: runId + naturalKey
      // + versionId + outcome + role. Two inserts with this SAME id simulate an
      // Inngest step retry re-executing the whole insert.
      const eventId = deterministicEventId(
        "run-oxa-1932-retry-sim",
        "github:conn-it:42",
        VERSION_ID,
        "accepted",
        "result",
      );

      await ch.insert({
        table: "schema_conformance_events",
        values: [baseRow({ event_id: eventId })],
        format: "JSONEachRow",
      });
      // Second "attempt" a moment later — same event_id, later occurred_at (the
      // ReplacingMergeTree version column), exactly what a retried step.run
      // produces today.
      await ch.insert({
        table: "schema_conformance_events",
        values: [
          baseRow({
            event_id: eventId,
            occurred_at: new Date(Date.now() + 1_000).toISOString(),
          }),
        ],
        format: "JSONEachRow",
      });

      // Force the background merge synchronously so dedup is guaranteed to have
      // applied before we query (production reads use FINAL and tolerate
      // eventual consistency; the test forces it for a deterministic assertion).
      await ch.command({
        query: "OPTIMIZE TABLE schema_conformance_events FINAL",
      });

      try {
        expect(await countByEventId(eventId)).toBe(1);
      } finally {
        await cleanup([eventId]);
      }
    }, 30_000);

    it("does NOT collapse two DIFFERENT deterministic event_ids (genuinely separate ingestion runs, not a retry)", async () => {
      const { clickhouse } = await import("./clickhouse");
      const { deterministicEventId } = await import("./idempotency");
      const ch = clickhouse();

      // Same naturalKey/versionId/outcome, but a DIFFERENT Inngest runId — the
      // scenario of the same entity being re-ingested on a later sync cycle,
      // which must NOT be treated as a retry of the earlier run.
      const eventIdRun1 = deterministicEventId(
        "run-oxa-1932-day-1",
        "github:conn-it:99",
        VERSION_ID,
        "accepted",
        "result",
      );
      const eventIdRun2 = deterministicEventId(
        "run-oxa-1932-day-2",
        "github:conn-it:99",
        VERSION_ID,
        "accepted",
        "result",
      );
      expect(eventIdRun1).not.toBe(eventIdRun2);

      await ch.insert({
        table: "schema_conformance_events",
        values: [
          baseRow({ event_id: eventIdRun1, node_id: "node-day-1" }),
          baseRow({ event_id: eventIdRun2, node_id: "node-day-2" }),
        ],
        format: "JSONEachRow",
      });
      await ch.command({
        query: "OPTIMIZE TABLE schema_conformance_events FINAL",
      });

      try {
        expect(await countByEventId(eventIdRun1)).toBe(1);
        expect(await countByEventId(eventIdRun2)).toBe(1);
      } finally {
        await cleanup([eventIdRun1, eventIdRun2]);
      }
    }, 30_000);
  },
);
