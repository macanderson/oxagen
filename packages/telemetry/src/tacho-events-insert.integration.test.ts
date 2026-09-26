import { randomUUID } from "node:crypto";
import {
  GENESIS_CURSOR,
  sealEvent,
  sessionUuid,
  TACHO_MAX_REQUEST_BYTES,
  type TachoEvent,
  type UnsealedTachoEvent,
} from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { clickhouse } from "./clickhouse";
import {
  insertTachoEvents,
  TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES,
} from "./tacho-events";

// CI migrates ClickHouse before the unit job, so `tacho_events` exists with
// every migration applied. Missing configuration skips local collection.
// This is the witness that the server accepts the insert's memory terms
// (#3662) and that the live column set matches the migrated table (#3072).

/** One small frame on `session`, the kind a host sends most of. */
function unsealedFrame(
  session: string,
  ts = new Date().toISOString(),
): UnsealedTachoEvent {
  return {
    v: "tacho/1.0",
    event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    session_id: "witness",
    session_uuid: session,
    root_session_uuid: session,
    ts,
    fidelity: "sdk",
    source: "hook",
    agent: {
      agent_key: "acme.core.witness",
      fleet_id: "wrk_1",
      runtime: "claude-code",
      harness: "claude-code",
      wrapper_version: "2.1.1",
    },
    attrs: {},
    kind: "agent_start",
    body: { session_start_source: "startup" },
  } satisfies UnsealedTachoEvent;
}

/** Rows `tacho_events` holds for `session` under `orgId`. */
async function storedRows(orgId: string, session: string): Promise<number> {
  const result = await clickhouse().query({
    query:
      "SELECT count() AS n FROM tacho_events WHERE org_id = {org:UUID} AND session_uuid = {session:UUID}",
    query_params: { org: orgId, session },
    format: "JSONEachRow",
  });
  const [row] = await result.json<{ n: string }>();
  return Number(row?.n);
}

describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "tacho_events insert against a live store",
  () => {
    it("writes a batch under its memory terms", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const event = sealEvent(unsealedFrame(session), GENESIS_CURSOR).event;

      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents([{ event, chainVerified: true }]),
      );

      expect(await storedRows(orgId, session)).toBe(1);
    });

    // #4297. The partition is the month the control plane received the row
    // in, not the producer's clock. A host whose clock jumps sends one batch
    // with frames in three months, and it lands in one partition, as one
    // part, not one part per month.
    it("files one batch in one partition whatever the producer's clock says", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const events: TachoEvent[] = [];
      let cursor = GENESIS_CURSOR;
      for (const ts of [
        "2026-01-15T10:00:00.000Z",
        "2026-05-15T10:00:00.000Z",
        "2031-01-01T00:00:00.000Z",
      ]) {
        const sealed = sealEvent(unsealedFrame(session, ts), cursor);
        events.push(sealed.event);
        cursor = sealed.next;
      }

      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents(
          events.map((event) => ({ event, chainVerified: true })),
        ),
      );

      const result = await clickhouse().query({
        query: `
          SELECT uniqExact(_partition_id) AS partitions,
                 uniqExact(_part) AS parts,
                 any(_partition_id) = toString(toYYYYMM(now64(3, 'UTC'))) AS this_month
          FROM tacho_events
          WHERE org_id = {org:UUID} AND session_uuid = {session:UUID}
        `,
        query_params: { org: orgId, session },
        format: "JSONEachRow",
      });
      const [row] = await result.json<{
        partitions: string;
        parts: string;
        this_month: number | boolean;
      }>();
      expect(Number(row?.partitions)).toBe(1);
      expect(Number(row?.parts)).toBe(1);
      expect(Boolean(row?.this_month)).toBe(true);
    });

    // #4316. The largest request a host may send, as the smallest frames, is
    // the most rows one insert can carry. Before 0033 a batch this size wrote
    // a wide part, whose writer needs more than the insert's 512 MiB bound, so
    // it failed with code 241 on every retry. The peak is printed so the CI
    // log records the measurement beside the pass.
    it("lands a batch the size of the largest request under its memory terms", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const events: TachoEvent[] = [];
      let cursor = GENESIS_CURSOR;
      // `{"events":[` and `]}` around the list, and a comma between frames.
      let bytes = 13;
      for (;;) {
        const sealed = sealEvent(unsealedFrame(session), cursor);
        const size = JSON.stringify(sealed.event).length + 1;
        if (bytes + size > TACHO_MAX_REQUEST_BYTES) break;
        bytes += size;
        events.push(sealed.event);
        cursor = sealed.next;
      }
      const since = Math.floor(Date.now() / 1000) - 1;

      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents(
          events.map((event) => ({ event, chainVerified: true })),
        ),
      );
      expect(await storedRows(orgId, session)).toBe(events.length);

      await clickhouse().command({ query: "SYSTEM FLUSH LOGS" });
      const logged = await clickhouse().query({
        query: `
          SELECT max(memory_usage) AS peak
          FROM system.query_log
          WHERE type = 'QueryFinish'
            AND query_kind = 'Insert'
            AND has(tables, concat(currentDatabase(), '.tacho_events'))
            AND written_rows = {rows:UInt64}
            AND event_time >= toDateTime({since:UInt32})
        `,
        query_params: { rows: events.length, since },
        format: "JSONEachRow",
      });
      const [row] = await logged.json<{ peak: string }>();
      const peak = Number(row?.peak);
      process.stdout.write(
        `tacho_events insert of ${events.length} frames (${bytes} bytes of JSON): peak memory ${(peak / 1_048_576).toFixed(1)} MiB\n`,
      );
      expect(peak).toBeGreaterThan(0);
      expect(peak).toBeLessThan(TACHO_EVENTS_INSERT_MAX_MEMORY_BYTES);
    }, 120_000);
  },
);
