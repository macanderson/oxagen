import { randomUUID } from "node:crypto";
import {
  GENESIS_CURSOR,
  sealEvent,
  sessionUuid,
  type UnsealedTachoEvent,
} from "@oxagen/tacho";
import { runInTenantScope } from "@oxagen/tenancy";
import { describe, expect, it } from "vitest";
import { clickhouse } from "./clickhouse";
import { insertTachoEvents } from "./tacho-events";

// CI migrates ClickHouse before the unit job, so `tacho_events` exists with
// every migration applied. Missing configuration skips local collection.
// This is the witness that the server accepts the insert's memory terms
// (#3662) and that the live column set matches the migrated table (#3072).
describe.skipIf(!process.env["CLICKHOUSE_URL"])(
  "tacho_events insert against a live store",
  () => {
    it("writes a batch under its memory terms", async () => {
      const orgId = randomUUID();
      const workspaceId = randomUUID();
      const session = sessionUuid("tch_witness", randomUUID());
      const unsealed = {
        v: "tacho/1.0",
        event_id: "evt_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        session_id: "witness",
        session_uuid: session,
        root_session_uuid: session,
        ts: new Date().toISOString(),
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
      const event = sealEvent(unsealed, GENESIS_CURSOR).event;

      await runInTenantScope({ orgId, workspaceId }, () =>
        insertTachoEvents([{ event, chainVerified: true }]),
      );

      const result = await clickhouse().query({
        query:
          "SELECT count() AS n FROM tacho_events WHERE org_id = {org:UUID} AND session_uuid = {session:UUID}",
        query_params: { org: orgId, session },
        format: "JSONEachRow",
      });
      const [row] = await result.json<{ n: string }>();
      expect(Number(row?.n)).toBe(1);
    });
  },
);
