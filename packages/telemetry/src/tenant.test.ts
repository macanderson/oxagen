// tenant.test.ts — ClickHouse tenant seam (chInsert / chSelect)
//
// Validates the four security invariants:
//   1. chInsert stamps org_id/workspace_id from scope onto every row.
//   2. chSelect binds orgId/workspaceId as query params.
//   3. chSelect rejects unsupported sources before contacting ClickHouse.
//   4. Both helpers fail closed when no tenant scope is active.

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoist the mock fns so they are available inside the vi.mock() factory.
const insert = vi.hoisted(() => vi.fn(async () => undefined));
const query = vi.hoisted(() =>
  vi.fn(async () => ({
    json: async <T>(): Promise<T> => ({ data: [] }) as unknown as T,
  })),
);

// Mock the ClickHouse singleton. tenant.ts imports from "./clickhouse" so we
// mock that module (client.ts is just a re-export barrel — not the import site).
vi.mock("./clickhouse", () => ({
  clickhouse: () => ({ insert, query }),
}));

import { runInTenantScope } from "@oxagen/tenancy";
import { chInsert, chSelect } from "./tenant";
import {
  selectAgentDaySpend,
  selectTachoEventRecords,
  selectTachoEvents,
} from "./tacho-events";

const ORG = "00000000-0000-0000-0000-00000000a111";
const WS = "00000000-0000-0000-0000-00000000b222";

describe("clickhouse tenant seam", () => {
  beforeEach(() => vi.clearAllMocks());
  it("stamps org_id/workspace_id onto inserted rows", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [{ event_type: "x" }]),
    );
    expect(insert).toHaveBeenCalledWith({
      table: "events",
      values: [{ event_type: "x", org_id: ORG, workspace_id: WS }],
      format: "JSONEachRow",
    });
  });

  it("overwrites hostile caller-supplied tenant columns", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chInsert("events", [
        {
          event_type: "x",
          org_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          workspace_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        },
      ]),
    );

    expect(insert).toHaveBeenCalledWith({
      table: "events",
      values: [{ event_type: "x", org_id: ORG, workspace_id: WS }],
      format: "JSONEachRow",
    });
  });

  it("binds orgId/workspaceId as query params on read", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      chSelect({ query: "SELECT 1 FROM events WHERE org_id = {orgId:UUID}" }),
    );
    expect(query).toHaveBeenCalledOnce();
    // Extract the first argument of the first call. Cast through unknown since
    // vi.fn() infers void params; the shape is validated by the assertions below.
    const callArg = query.mock.calls[0] as unknown as [
      { query: string; query_params: Record<string, string>; format: string },
    ];
    expect(callArg[0]?.query_params.orgId).toBe(ORG);
    expect(callArg[0]?.query_params.workspaceId).toBe(WS);
  });

  it("rejects a read query that omits org_id (guard)", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, async () => {
      await expect(chSelect({ query: "SELECT 1" })).rejects.toThrow(/org_id/);
    });
  });

  it.each([
    "SELECT org_id FROM events",
    "SELECT * FROM events WHERE id IN (1, 2)",
    "SELECT * FROM events WHERE id IN [1, 2]",
    "SELECT * FROM events WHERE id IN {ids:Array(UUID)}",
    "SELECT count() FROM events WHERE 1 = 1 OR org_id = {orgId:UUID}",
    "SELECT org_id FROM events FINAL GROUP BY org_id",
  ])(
    "scopes the source independently of the outer expression: %s",
    async (sql) => {
      await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
        chSelect({
          query: sql,
          params: { orgId: "foreign", workspaceId: "foreign", ids: [ORG] },
        }),
      );
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringMatching(
            /FROM \(SELECT \* FROM events(?: FINAL)? WHERE org_id = \{orgId:UUID\} AND workspace_id = \{workspaceId:UUID\}\) AS events/,
          ),
          query_params: { orgId: ORG, workspaceId: WS, ids: [ORG] },
        }),
      );
    },
  );

  it.each([
    "SELECT {victim:UUID} IN foreign_events FROM events",
    "SELECT * FROM events WHERE id NOT IN foreign_events",
    "SELECT * FROM events WHERE id GLOBAL IN other.foreign_events",
    'SELECT * FROM events WHERE id IN "foreign_events"',
    "SELECT * FROM events WHERE id IN `foreign_events`",
    "SELECT * FROM events WHERE id in remote('host', 'foreign_events')",
    "SELECT * FROM events WHERE id IN {table:Identifier}",
    "SELECT * FROM events UNION ALL SELECT * FROM foreign_events",
    "SELECT * FROM events WHERE id IN (SELECT id FROM foreign_events)",
    "SELECT * FROM events -- org_id = {orgId:UUID}",
    "SELECT * FROM events /* org_id */",
    "SELECT 'FROM events' AS org_id FROM foreign_events",
    "SELECT * FROM events, foreign_events",
    "SELECT * FROM remote('host', 'table')",
    "SELECT * FROM events JOIN foreign_events USING (org_id)",
    "SELECT * FROM events; SELECT * FROM foreign_events",
  ])(
    "refuses unsupported query syntax before contacting ClickHouse: %s",
    async (sql) => {
      await expect(
        runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
          chSelect({ query: sql }),
        ),
      ).rejects.toThrow(/org_id/);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["selectTachoEvents", selectTachoEvents],
    ["selectTachoEventRecords", selectTachoEventRecords],
  ] as const)(
    "passes %s through the source fence with FINAL kept",
    async (_name, select) => {
      await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
        select({
          sessionUuid: "00000000-0000-0000-0000-00000000c333",
          afterSeq: -1,
          limit: 500,
        }),
      );
      expect(query).toHaveBeenCalledOnce();
      expect(query).toHaveBeenCalledWith(
        expect.objectContaining({
          query: expect.stringContaining(
            "FROM (SELECT * FROM tacho_events FINAL WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}) AS tacho_events",
          ),
          query_params: expect.objectContaining({
            orgId: ORG,
            workspaceId: WS,
          }),
        }),
      );
    },
  );

  it("passes selectAgentDaySpend through the source fence with FINAL kept (ADR-160)", async () => {
    await runInTenantScope({ orgId: ORG, workspaceId: WS }, () =>
      selectAgentDaySpend({ day: "2026-09-24", hostEnrollmentIds: ["tch_a"] }),
    );
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining(
          "FROM (SELECT * FROM tacho_events FINAL WHERE org_id = {orgId:UUID} AND workspace_id = {workspaceId:UUID}) AS tacho_events",
        ),
        query_params: expect.objectContaining({
          orgId: ORG,
          workspaceId: WS,
          hosts: ["tch_a"],
          start: "2026-09-24 00:00:00.000",
        }),
      }),
    );
  });

  it("fails closed with no scope", async () => {
    await expect(chInsert("events", [{}])).rejects.toThrow(/tenant scope/);
  });
});
